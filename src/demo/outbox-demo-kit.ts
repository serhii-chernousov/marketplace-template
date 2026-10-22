import { DataSource } from 'typeorm'
import { asRows } from '../common/pg-rows'
import { CheckoutService } from '../checkout/checkout.service'
import base from '../database/data-source'
import { EffectStore } from '../messaging/effect-store'
import { OutboxRelay } from '../messaging/outbox-relay'

const BUYER_EMAIL = 'outbox-demo-buyer@shop.local'
const SELLER_EMAIL = 'outbox-demo-seller@shop.local'
const PRODUCT_NAME = 'Outbox Demo Item'

export interface OutboxDemoCounts {
	orders: number
	outbox: number
	published: number
	deliveries: number
	effect: number
	processed: number
	applied: number
}

export interface OutboxDemoWorld {
	ds: DataSource
	checkout: CheckoutService
	relay: OutboxRelay
	store: EffectStore
	userId: string
	productId: string
	counts: () => Promise<OutboxDemoCounts>
}

async function scalar(
	ds: DataSource,
	sql: string,
	params: unknown[] = [],
): Promise<number> {
	const rows = asRows<{ n: string }>(await ds.query(sql, params))
	return Number(rows[0]?.n ?? 0)
}

/**
 * Fresh buyer, product, and telemetry tables for one outbox demo.
 * Seed orders of other users are left in place; counts are scoped to this buyer.
 */
export async function prepareOutboxDemo(): Promise<OutboxDemoWorld> {
	const ds = new DataSource({ ...base.options })
	await ds.initialize()

	const sellerRows = asRows<{ id: string }>(
		await ds.query(
			`
			INSERT INTO users (email, full_name, role, balance_cents)
			VALUES ($1, 'Outbox Demo Seller', 'seller', 0)
			ON CONFLICT (email) DO UPDATE SET is_active = true
			RETURNING id
			`,
			[SELLER_EMAIL],
		),
	)
	const buyerRows = asRows<{ id: string }>(
		await ds.query(
			`
			INSERT INTO users (email, full_name, role, balance_cents)
			VALUES ($1, 'Outbox Demo Buyer', 'buyer', 100000000)
			ON CONFLICT (email) DO UPDATE
			SET balance_cents = 100000000, is_active = true
			RETURNING id
			`,
			[BUYER_EMAIL],
		),
	)
	const userId = String(buyerRows[0].id)
	const sellerId = String(sellerRows[0].id)

	await ds.query(
		`
		DELETE FROM jobs
		WHERE payload->>'orderId' IN (
			SELECT id::text FROM orders WHERE user_id = $1
		)
		`,
		[userId],
	)
	await ds.query(`DELETE FROM outbox WHERE payload->>'userId' = $1`, [userId])
	await ds.query(`DELETE FROM orders WHERE user_id = $1`, [userId])

	const productRows = asRows<{ id: string }>(
		await ds.query(
			`
			INSERT INTO products (
				name, description, price_cents, stock, is_active, seller_id
			)
			VALUES ($1, '', 1000, 1000, true, $2)
			ON CONFLICT (name) DO UPDATE
			SET stock = 1000, is_active = true, price_cents = 1000
			RETURNING id
			`,
			[PRODUCT_NAME, sellerId],
		),
	)

	await ds.query(
		`TRUNCATE order_placed_deliveries, order_placed_effects, processed_messages`,
	)

	const productId = String(productRows[0].id)
	const counts = async (): Promise<OutboxDemoCounts> => {
		const orders = await scalar(
			ds,
			`SELECT count(*)::text AS n FROM orders WHERE user_id = $1`,
			[userId],
		)
		const outbox = await scalar(
			ds,
			`SELECT count(*)::text AS n FROM outbox WHERE payload->>'userId' = $1`,
			[userId],
		)
		const published = await scalar(
			ds,
			`
			SELECT count(*)::text AS n
			FROM outbox
			WHERE payload->>'userId' = $1 AND published_at IS NOT NULL
			`,
			[userId],
		)
		const deliveries = await scalar(
			ds,
			`SELECT count(*)::text AS n FROM order_placed_deliveries`,
		)
		const effect = await scalar(
			ds,
			`SELECT count(*)::text AS n FROM order_placed_effects`,
		)
		const processed = await scalar(
			ds,
			`SELECT count(*)::text AS n FROM processed_messages`,
		)
		return {
			orders,
			outbox,
			published,
			deliveries,
			effect,
			processed,
			applied: effect,
		}
	}

	return {
		ds,
		checkout: new CheckoutService(ds),
		relay: new OutboxRelay(ds),
		store: new EffectStore(ds),
		userId,
		productId,
		counts,
	}
}
