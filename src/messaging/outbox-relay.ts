import { DataSource } from 'typeorm'
import { asRows } from '../common/pg-rows'
import { OrderPlacedEvent } from './order-placed.event'
import {
	publishOrderPlaced,
	withOrderPlacedChannel,
} from './order-placed.publisher'

/**
 * Relay died after the broker accepted the publish and before
 * `published_at` was updated. The DB transaction rolls back;
 * the message stays in the broker.
 */
export class RelayCrashedError extends Error {
	constructor() {
		super('relay stopped after publish and before published_at update')
		this.name = 'RelayCrashedError'
	}
}

export interface RelayOptions {
	limit?: number
	/**
	 * Simulated crash: throw after a successful publish, before UPDATE.
	 * Same window as kill -9 between those two steps.
	 */
	crashAfterPublish?: boolean
	/** When set, only rows for this buyer are claimed. */
	userId?: string
}

function asOrderPlacedEvent(payload: unknown): OrderPlacedEvent {
	const event: unknown =
		typeof payload === 'string' ? JSON.parse(payload) : payload
	if (
		!event ||
		typeof event !== 'object' ||
		typeof (event as OrderPlacedEvent).eventId !== 'string' ||
		(event as OrderPlacedEvent).type !== 'order.placed'
	) {
		throw new Error('outbox payload is not an order.placed event')
	}
	return event as OrderPlacedEvent
}

/**
 * Polling relay. Lock unpublished rows, publish, then set published_at.
 * The mark stays after publish: a crash here duplicates, it does not lose.
 * SKIP LOCKED lets a second worker claim other rows instead of waiting.
 */
export class OutboxRelay {
	constructor(private readonly dataSource: DataSource) {}

	/**
	 * @returns how many messages were published and marked.
	 * A crash throws instead of returning — the publish already happened.
	 */
	async publishPending(options: RelayOptions = {}): Promise<number> {
		const limit = options.limit ?? 20
		let failedAttemptId: string | null = null
		try {
			return await this.dataSource.transaction(async (manager) => {
				const rows = asRows<{ id: string; payload: unknown }>(
					await manager.query(
						`
						SELECT id, payload
						FROM outbox
						WHERE published_at IS NULL
							AND ($2::text IS NULL OR payload->>'userId' = $2)
						ORDER BY created_at, id
						FOR UPDATE SKIP LOCKED
						LIMIT $1
						`,
						[limit, options.userId ?? null],
					),
				)
				if (rows.length === 0) {
					return 0
				}

				return withOrderPlacedChannel(async (channel) => {
					let published = 0
					for (const row of rows) {
						const event = asOrderPlacedEvent(row.payload)
						try {
							await publishOrderPlaced(event, channel)
						} catch (err) {
							failedAttemptId = row.id
							throw err
						}
						published += 1
						if (options.crashAfterPublish) {
							throw new RelayCrashedError()
						}
						await manager.query(
							`
							UPDATE outbox
							SET published_at = now(),
								attempts = attempts + 1
							WHERE id = $1
							`,
							[row.id],
						)
					}
					return published
				})
			})
		} catch (err) {
			if (failedAttemptId !== null) {
				// The claim transaction rolls back with the failed publish,
				// so this increment has to commit on its own. Otherwise
				// attempts stays 0 and backoff has nothing to read.
				await this.dataSource.query(
					`
					UPDATE outbox
					SET attempts = attempts + 1
					WHERE id = $1
					`,
					[failedAttemptId],
				)
			}
			throw err
		}
	}
}
