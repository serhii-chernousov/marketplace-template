import { DataSource } from 'typeorm'
import { asRows } from '../common/pg-rows'
import { OrderPlacedEvent } from './order-placed.event'

/** Inbox consumer name for order.placed. One row per (message, consumer). */
export const ORDER_PLACED_CONSUMER = 'order-placed'

export interface EffectCounts {
	deliveries: number
	effect: number
	acked: number
	skipped: number
}

/**
 * Durable idempotent effect for order.placed.
 * INSERT … ON CONFLICT DO NOTHING by event_id — survives restarts and replicas.
 */
export class EffectStore {
	private successfulApplies = 0

	constructor(private readonly dataSource: DataSource) {}

	async reset(): Promise<void> {
		await this.dataSource.query(
			`TRUNCATE order_placed_deliveries, order_placed_effects, processed_messages`,
		)
		this.successfulApplies = 0
	}

	async recordDelivery(eventId: string): Promise<void> {
		await this.dataSource.query(
			`
			INSERT INTO order_placed_deliveries (event_id)
			VALUES ($1::uuid)
			`,
			[eventId],
		)
	}

	/**
	 * Inbox mark and business effect commit together.
	 * A duplicate delivery conflicts on both and changes neither.
	 *
	 * @returns true when the effect row was inserted (first delivery);
	 * false when event_id already existed (duplicate delivery).
	 */
	async applyEffect(event: OrderPlacedEvent): Promise<boolean> {
		const applied = await this.dataSource.transaction(async (manager) => {
			await manager.query(
				`
				INSERT INTO processed_messages (message_id, consumer)
				VALUES ($1::uuid, $2)
				ON CONFLICT (message_id, consumer) DO NOTHING
				`,
				[event.eventId, ORDER_PLACED_CONSUMER],
			)
			const rows = asRows<{ event_id: string }>(
				await manager.query(
					`
					INSERT INTO order_placed_effects (event_id, order_id, occurred_at)
					VALUES ($1::uuid, $2, $3::timestamptz)
					ON CONFLICT (event_id) DO NOTHING
					RETURNING event_id
					`,
					[event.eventId, event.orderId, event.occurredAt],
				),
			)
			return rows.length > 0
		})
		if (applied) {
			this.successfulApplies += 1
		}
		return applied
	}

	/**
	 * How many applyEffect calls returned true.
	 * Not the effect-table row count: a duplicate delivery leaves the table
	 * unchanged and does not increment this.
	 */
	appliedCount(): number {
		return this.successfulApplies
	}

	async markAcked(eventId: string): Promise<void> {
		await this.dataSource.query(
			`
			UPDATE order_placed_effects
			SET acked_at = now()
			WHERE event_id = $1::uuid AND acked_at IS NULL
			`,
			[eventId],
		)
	}

	async counts(): Promise<EffectCounts> {
		const deliveryRows = asRows<{ n: string }>(
			await this.dataSource.query(
				`SELECT count(*)::text AS n FROM order_placed_deliveries`,
			),
		)
		const effectRows = asRows<{ n: string }>(
			await this.dataSource.query(
				`SELECT count(*)::text AS n FROM order_placed_effects`,
			),
		)
		const ackedRows = asRows<{ n: string }>(
			await this.dataSource.query(
				`
				SELECT count(*)::text AS n
				FROM order_placed_effects
				WHERE acked_at IS NOT NULL
				`,
			),
		)
		const deliveries = Number(deliveryRows[0]?.n ?? 0)
		const effect = Number(effectRows[0]?.n ?? 0)
		const acked = Number(ackedRows[0]?.n ?? 0)
		return {
			deliveries,
			effect,
			acked,
			skipped: Math.max(0, deliveries - effect),
		}
	}
}
