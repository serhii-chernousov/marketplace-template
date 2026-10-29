import {
	Injectable,
	Logger,
	OnApplicationBootstrap,
	OnModuleDestroy,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Job, Queue, Worker } from 'bullmq'
import { ProductCardService } from '../catalog/product-card.service'
import type { Env } from '../config/env.schema'
import {
	QUEUE_PREFIX,
	RATING_QUEUE,
	SWEEP_JOB,
	upsertSweepScheduler,
	type RatingJobData,
} from './rating-queue'

const SWEEP_EVERY_MS = 10 * 60 * 1000
const HOT_PRODUCTS = 20

/**
 * Consumer side: recalculates product cards after orders and keeps the
 * most ordered ones warm on a schedule.
 */
@Injectable()
export class RatingWorker implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly logger = new Logger(RatingWorker.name)
	private worker?: Worker<RatingJobData>
	private scheduler?: Queue<RatingJobData>

	constructor(
		private readonly config: ConfigService<Env, true>,
		private readonly cards: ProductCardService,
	) {}

	async onApplicationBootstrap(): Promise<void> {
		const url = this.config.get('REDIS_QUEUE_URL', { infer: true })
		if (!url) {
			throw new Error('REDIS_QUEUE_URL is required')
		}
		// null: on a dropped connection the worker waits for Redis instead of crashing.
		this.worker = new Worker<RatingJobData>(
			RATING_QUEUE,
			(job) => this.process(job),
			{ connection: { url, maxRetriesPerRequest: null }, prefix: QUEUE_PREFIX },
		)
		this.worker.on('failed', (job, err) => {
			this.logger.warn(`${job?.name} ${job?.id} failed: ${err.message}`)
		})
		await this.worker.waitUntilReady()

		this.scheduler = new Queue<RatingJobData>(RATING_QUEUE, {
			connection: { url },
			prefix: QUEUE_PREFIX,
		})
		await upsertSweepScheduler(this.scheduler, SWEEP_EVERY_MS)
		this.logger.log(`listening on ${RATING_QUEUE}`)
	}

	async onModuleDestroy(): Promise<void> {
		await this.worker?.close()
		await this.scheduler?.close()
	}

	private async process(job: Job<RatingJobData>): Promise<void> {
		if (job.name === SWEEP_JOB) {
			const ids = await this.cards.hotProductIds(HOT_PRODUCTS)
			for (const productId of ids) {
				await this.cards.refresh(productId)
			}
			return
		}
		if (job.data.productId) {
			await this.cards.refresh(job.data.productId)
		}
	}
}
