import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Queue } from 'bullmq'
import type { Env } from '../config/env.schema'
import {
	QUEUE_PREFIX,
	RATING_QUEUE,
	RECALC_JOB,
	ratingJobOptions,
	type RatingJobData,
} from './rating-queue'

const PRODUCER_RECONNECTS = 3
const PRODUCER_RECONNECT_MS = 200

/**
 * Producer side. The queue is opened on first use so the API boots
 * without Redis. Bounded reconnects: with retries forever, add() never
 * settles while Redis is down and shutdown hangs on it.
 */
@Injectable()
export class RatingQueueService implements OnModuleDestroy {
	private readonly logger = new Logger(RatingQueueService.name)
	private queue?: Queue<RatingJobData>

	constructor(private readonly config: ConfigService<Env, true>) {}

	/** jobId per order and product: a repeated enqueue is one job. */
	async enqueueRecalc(orderId: string, productIds: string[]): Promise<void> {
		const queue = this.open()
		try {
			await Promise.all(
				[...new Set(productIds)].map((productId) =>
					queue.add(
						RECALC_JOB,
						{ productId },
						{ jobId: `recalc-${orderId}-${productId}` },
					),
				),
			)
		} catch (err) {
			// The connection gave up retrying; the next enqueue opens a fresh one.
			this.queue = undefined
			await queue.close()
			throw err
		}
	}

	/** Fire-and-forget for request handlers: the order is already committed. */
	enqueueRecalcInBackground(orderId: string, productIds: string[]): void {
		this.enqueueRecalc(orderId, productIds).catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err)
			this.logger.warn(`rating recalc not queued: ${message}`)
		})
	}

	async onModuleDestroy(): Promise<void> {
		await this.queue?.close()
	}

	private open(): Queue<RatingJobData> {
		if (!this.queue) {
			const url = this.config.get('REDIS_QUEUE_URL', { infer: true })
			if (!url) {
				throw new Error('REDIS_QUEUE_URL is required')
			}
			this.queue = new Queue<RatingJobData>(RATING_QUEUE, {
				connection: {
					url,
					maxRetriesPerRequest: 1,
					enableOfflineQueue: false,
					retryStrategy: (attempt) =>
						attempt > PRODUCER_RECONNECTS ? null : PRODUCER_RECONNECT_MS,
				},
				prefix: QUEUE_PREFIX,
				defaultJobOptions: ratingJobOptions,
			})
			this.queue.on('error', (err) => {
				this.logger.warn(`rating queue: ${err.message}`)
			})
		}
		return this.queue
	}
}
