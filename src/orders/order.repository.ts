import { Injectable } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { asRows } from '../common/pg-rows'
import { Order as OrderRow, OrderStatus } from '../entities/order.entity'
import { logger } from '../observability/logger'

const log = logger.child({ layer: 'orders.repo' })

export interface OrderPageFilter {
	buyerId?: string
	sellerId?: string
	limit: number
	beforeId?: string
}

@Injectable()
export class OrderRepository {
	constructor(private readonly dataSource: DataSource) {}

	async findWithItems(dbId: string): Promise<OrderRow | undefined> {
		if (!/^\d+$/.test(dbId)) {
			return undefined
		}
		const rows = await this.loadWithItems([dbId])
		log.debug({ orderId: dbId, found: rows.length > 0 }, 'order row loaded')
		return rows[0]
	}

	/**
	 * Keyset page, newest first. Ids are selected first, so LIMIT counts
	 * orders rather than joined item rows.
	 */
	async findPage(
		filter: OrderPageFilter,
	): Promise<{ rows: OrderRow[]; hasMore: boolean }> {
		const idRows = asRows<{ id: string }>(
			await this.dataSource.query(
				`
				SELECT o.id::text AS id
				FROM orders o
				WHERE ($1::bigint IS NULL OR o.user_id = $1::bigint)
					AND ($2::bigint IS NULL OR EXISTS (
						SELECT 1
						FROM order_items oi
						JOIN products p ON p.id = oi.product_id
						WHERE oi.order_id = o.id AND p.seller_id = $2::bigint
					))
					AND ($3::bigint IS NULL OR o.id < $3::bigint)
				ORDER BY o.id DESC
				LIMIT $4
				`,
				[
					filter.buyerId ?? null,
					filter.sellerId ?? null,
					filter.beforeId ?? null,
					filter.limit + 1,
				],
			),
		)
		const hasMore = idRows.length > filter.limit
		const ids = idRows.slice(0, filter.limit).map((row) => row.id)
		const rows = await this.loadWithItems(ids)
		rows.sort((left, right) => Number(right.id) - Number(left.id))
		log.debug({ count: rows.length, hasMore }, 'order page loaded')
		return { rows, hasMore }
	}

	/**
	 * Compare-and-set on the current status. A cancel returns stock and money
	 * in the same transaction, so a cancelled order never keeps either.
	 */
	async transitionStatus(
		dbId: string,
		to: OrderStatus,
		from: readonly OrderStatus[],
	): Promise<boolean> {
		return this.dataSource.transaction(async (manager) => {
			const updated = asRows<{ user_id: string; total_cents: number }>(
				await manager.query(
					`
					UPDATE orders
					SET status = $2
					WHERE id = $1::bigint AND status = ANY($3::text[])
					RETURNING user_id, total_cents
					`,
					[dbId, to, from],
				),
			)
			if (updated.length === 0) {
				return false
			}
			if (to === 'cancelled') {
				await manager.query(
					`
					UPDATE products p
					SET stock = p.stock + oi.quantity
					FROM order_items oi
					WHERE oi.order_id = $1::bigint AND oi.product_id = p.id
					`,
					[dbId],
				)
				await manager.query(
					`
					UPDATE users
					SET balance_cents = balance_cents + $2
					WHERE id = $1::bigint
					`,
					[updated[0].user_id, updated[0].total_cents],
				)
			}
			log.info({ orderId: dbId, to }, 'order status changed')
			return true
		})
	}

	private async loadWithItems(ids: string[]): Promise<OrderRow[]> {
		if (ids.length === 0) {
			return []
		}
		const rows = await this.dataSource
			.getRepository(OrderRow)
			.createQueryBuilder('ord')
			.leftJoinAndSelect('ord.user', 'buyer')
			.leftJoinAndSelect('ord.items', 'item')
			.leftJoinAndSelect('item.product', 'product')
			.leftJoinAndSelect('product.seller', 'seller')
			.where('ord.id IN (:...ids)', { ids })
			.getMany()
		for (const row of rows) {
			row.items?.sort((left, right) =>
				left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
			)
		}
		return rows
	}
}
