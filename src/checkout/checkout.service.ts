import { Injectable } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { asRows } from '../common/pg-rows'
import { withRetry } from '../common/with-retry'
import { toOrderPlacedEvent } from '../messaging/order-placed.event'

export interface CheckoutItemInput {
	productId: string
	quantity: number
}

export interface CheckoutInput {
	userId: string
	items: CheckoutItemInput[]
	idempotencyKey?: string
	requestHash?: string
	failAfterOutbox?: boolean
}

export interface CheckoutResult {
	orderId: string
	jobId: string
	totalCents: number
	unitPrices: number[]
	replay: boolean
}

export class OutOfStockError extends Error {
	constructor(message = 'Out of stock') {
		super(message)
		this.name = 'OutOfStockError'
	}
}

export class InsufficientFundsError extends Error {
	constructor(message = 'Insufficient funds') {
		super(message)
		this.name = 'InsufficientFundsError'
	}
}

/** Same Idempotency-Key, different request body. */
export class IdempotencyKeyConflictError extends Error {
	constructor(message = 'Idempotency key conflict') {
		super(message)
		this.name = 'IdempotencyKeyConflictError'
	}
}

/**
 * Checkout aborted after the outbox insert and before COMMIT.
 * The order row and the outbox row disappear together.
 */
export class OutboxWriteAbortedError extends Error {
	constructor(message = 'business write aborted after outbox insert') {
		super(message)
		this.name = 'OutboxWriteAbortedError'
	}
}

/** Lost the race to insert the same intent key. The other transaction won. */
class IdempotencyReplayError extends Error {
	constructor() {
		super('idempotency key already committed')
		this.name = 'IdempotencyReplayError'
	}
}

/**
 * Stable product row-lock order. Opposite request orders on the same
 * products deadlock (40P01); original indexes keep unitPrices aligned.
 */
function itemsInLockOrder(
	items: CheckoutItemInput[],
): Array<{ item: CheckoutItemInput; index: number }> {
	return items
		.map((item, index) => ({ item, index }))
		.sort((left, right) => {
			if (left.item.productId < right.item.productId) {
				return -1
			}
			if (left.item.productId > right.item.productId) {
				return 1
			}
			return left.index - right.index
		})
}

/**
 * Atomic marketplace checkout: stock, balance, order rows, outbox, intent key.
 * The broker is not called here — a relay publishes after COMMIT.
 * Injectable in Nest; demos may also `new CheckoutService(dataSource)`.
 */
@Injectable()
export class CheckoutService {
	constructor(private readonly dataSource: DataSource) {}

	/**
	 * Single-product helper used by concurrency demos.
	 */
	checkoutOne(
		userId: string,
		productId: string,
		quantity: number,
	): Promise<CheckoutResult> {
		return this.checkout({
			userId,
			items: [{ productId, quantity }],
		})
	}

	async checkout(input: CheckoutInput): Promise<CheckoutResult> {
		if (!input.items.length) {
			throw new Error('Checkout requires at least one item')
		}
		for (const item of input.items) {
			if (!Number.isInteger(item.quantity) || item.quantity < 1) {
				throw new Error(`Invalid quantity ${item.quantity}`)
			}
		}

		if (input.idempotencyKey) {
			const existing = await this.findCommitted(
				input.userId,
				input.idempotencyKey,
			)
			if (existing) {
				this.assertSameIntent(existing.requestHash, input.requestHash)
				return existing.result
			}
		}

		const lockedItems = itemsInLockOrder(input.items)

		try {
			return await withRetry(() => this.insertCheckout(input, lockedItems))
		} catch (err: unknown) {
			if (err instanceof IdempotencyReplayError && input.idempotencyKey) {
				const existing = await this.findCommitted(
					input.userId,
					input.idempotencyKey,
				)
				if (!existing) {
					throw err
				}
				this.assertSameIntent(existing.requestHash, input.requestHash)
				return existing.result
			}
			throw err
		}
	}

	private async insertCheckout(
		input: CheckoutInput,
		lockedItems: Array<{ item: CheckoutItemInput; index: number }>,
	): Promise<CheckoutResult> {
		return this.dataSource.transaction(async (manager) => {
			let totalCents = 0
			const unitPrices = new Array<number>(input.items.length)
			const pricedItems: Array<{
				productId: string
				quantity: number
				unitPriceCents: number
			}> = []

			for (const { item, index } of lockedItems) {
				const productRows = asRows<{
					stock: number
					price_cents: number
				}>(
					await manager.query(
						`
						UPDATE products
						SET stock = stock - $1
						WHERE id = $2 AND is_active = true AND stock >= $1
						RETURNING stock, price_cents
						`,
						[item.quantity, item.productId],
					),
				)
				if (productRows.length === 0) {
					throw new OutOfStockError()
				}
				const unitPriceCents = Number(productRows[0].price_cents)
				unitPrices[index] = unitPriceCents
				totalCents += unitPriceCents * item.quantity
				pricedItems.push({
					productId: item.productId,
					quantity: item.quantity,
					unitPriceCents,
				})
			}

			const balanceRows = asRows<{ balance_cents: number }>(
				await manager.query(
					`
					UPDATE users
					SET balance_cents = balance_cents - $1
					WHERE id = $2 AND balance_cents >= $1
					RETURNING balance_cents
					`,
					[totalCents, input.userId],
				),
			)
			if (balanceRows.length === 0) {
				throw new InsufficientFundsError()
			}

			const orderRows = asRows<{ id: string }>(
				await manager.query(
					`
					INSERT INTO orders (user_id, status, total_cents)
					VALUES ($1, 'paid', $2)
					RETURNING id
					`,
					[input.userId, totalCents],
				),
			)
			const orderId = String(orderRows[0].id)

			for (const item of pricedItems) {
				await manager.query(
					`
					INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
					VALUES ($1, $2, $3, $4)
					`,
					[orderId, item.productId, item.quantity, item.unitPriceCents],
				)
			}

			const jobRows = asRows<{ id: string }>(
				await manager.query(
					`
					INSERT INTO jobs (kind, payload, status)
					VALUES ('order.postprocess', $1::jsonb, 'pending')
					RETURNING id
					`,
					[JSON.stringify({ orderId })],
				),
			)

			const event = toOrderPlacedEvent({
				orderId: `order-${orderId}`,
				userId: input.userId,
				totalCents,
			})
			await manager.query(
				`
					INSERT INTO outbox (aggregate_type, aggregate_id, type, payload)
					VALUES ('order', $1, 'order.placed', $2::jsonb)
					`,
				[orderId, JSON.stringify(event)],
			)
			if (input.failAfterOutbox) {
				throw new OutboxWriteAbortedError()
			}

			if (input.idempotencyKey) {
				const keyRows = asRows<{ order_id: string }>(
					await manager.query(
						`
							INSERT INTO idempotency_keys (
								user_id, idempotency_key, order_id, request_hash
							)
							VALUES ($1, $2, $3, $4)
							ON CONFLICT (user_id, idempotency_key) DO NOTHING
							RETURNING order_id
							`,
						[
							input.userId,
							input.idempotencyKey,
							orderId,
							input.requestHash ?? '',
						],
					),
				)
				if (keyRows.length === 0) {
					throw new IdempotencyReplayError()
				}
			}

			return {
				orderId,
				jobId: String(jobRows[0].id),
				totalCents,
				unitPrices,
				replay: false,
			}
		})
	}

	private assertSameIntent(stored: string, incoming: string | undefined): void {
		if (incoming !== undefined && incoming !== stored) {
			throw new IdempotencyKeyConflictError()
		}
	}

	private async findCommitted(
		userId: string,
		idempotencyKey: string,
	): Promise<{ requestHash: string; result: CheckoutResult } | null> {
		const rows = asRows<{
			order_id: string
			request_hash: string
			total_cents: number
			job_id: string | null
		}>(
			await this.dataSource.query(
				`
				SELECT
					k.order_id,
					k.request_hash,
					o.total_cents,
					(
						SELECT j.id
						FROM jobs j
						WHERE j.payload->>'orderId' = o.id::text
						ORDER BY j.id DESC
						LIMIT 1
					) AS job_id
				FROM idempotency_keys k
				JOIN orders o ON o.id = k.order_id
				WHERE k.user_id = $1 AND k.idempotency_key = $2
				`,
				[userId, idempotencyKey],
			),
		)
		if (rows.length === 0) {
			return null
		}
		const priceRows = asRows<{ unit_price_cents: number }>(
			await this.dataSource.query(
				`
				SELECT unit_price_cents
				FROM order_items
				WHERE order_id = $1
				ORDER BY id
				`,
				[rows[0].order_id],
			),
		)
		return {
			requestHash: rows[0].request_hash,
			result: {
				orderId: String(rows[0].order_id),
				jobId: rows[0].job_id ? String(rows[0].job_id) : '',
				totalCents: Number(rows[0].total_cents),
				unitPrices: priceRows.map((row) => Number(row.unit_price_cents)),
				replay: true,
			},
		}
	}
}
