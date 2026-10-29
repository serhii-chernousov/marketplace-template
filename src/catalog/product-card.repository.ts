import { Injectable } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { asRows } from '../common/pg-rows'

/**
 * Product card: identity, stock, and a demand rating aggregated from
 * order lines. There is no reviews table; the rating is the average
 * line quantity, which is the join this cache exists to avoid.
 */
export interface ProductCard {
	id: string
	name: string
	stock: number
	priceCents: number
	rating: number
	orderLines: number
}

/**
 * Counts SQL at the repository, next to the query — not at the cache caller.
 */
@Injectable()
export class ProductCardRepository {
	dbCalls = 0

	constructor(private readonly dataSource: DataSource) {}

	reset(): void {
		this.dbCalls = 0
	}

	async hotProductIds(limit: number): Promise<string[]> {
		this.dbCalls += 1
		const rows = asRows<{ id: string }>(
			await this.dataSource.query(
				`
				SELECT product_id::text AS id
				FROM order_items
				GROUP BY product_id
				ORDER BY COUNT(*) DESC
				LIMIT $1
				`,
				[limit],
			),
		)
		return rows.map((row) => row.id)
	}

	/** One round-trip: product row plus aggregate over its order lines. */
	async load(productId: string): Promise<ProductCard | null> {
		this.dbCalls += 1
		const rows = asRows<ProductCard>(
			await this.dataSource.query(
				`
				SELECT
					p.id::text AS id,
					p.name,
					p.stock,
					p.price_cents AS "priceCents",
					COALESCE(COUNT(oi.id), 0)::int AS "orderLines",
					COALESCE(ROUND(AVG(oi.quantity)::numeric, 2), 0)::float8 AS rating
				FROM products p
				LEFT JOIN order_items oi ON oi.product_id = p.id
				WHERE p.id = $1::bigint
				GROUP BY p.id, p.name, p.stock, p.price_cents
				`,
				[productId],
			),
		)
		const row = rows[0]
		if (!row) {
			return null
		}
		return {
			id: String(row.id),
			name: row.name,
			stock: Number(row.stock),
			priceCents: Number(row.priceCents),
			rating: Number(row.rating),
			orderLines: Number(row.orderLines),
		}
	}
}
