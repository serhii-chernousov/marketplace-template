import { Injectable } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { asRows } from '../common/pg-rows'

export interface CheckoutItemInput {
	productId: string
	quantity: number
}

export interface CheckoutInput {
	userId: string
	items: CheckoutItemInput[]
}

export interface CheckoutResult {
	orderId: string
	jobId: string
	totalCents: number
	unitPrices: number[]
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

/**
 * Atomic marketplace checkout: stock, balance, order rows, post-process job.
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

		return this.dataSource.transaction(async (manager) => {
			let totalCents = 0
			const unitPrices: number[] = []
			const pricedItems: Array<{
				productId: string
				quantity: number
				unitPriceCents: number
			}> = []

			for (const item of input.items) {
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
				unitPrices.push(unitPriceCents)
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
					[
						orderId,
						item.productId,
						item.quantity,
						item.unitPriceCents,
					],
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

			return {
				orderId,
				jobId: String(jobRows[0].id),
				totalCents,
				unitPrices,
			}
		})
	}
}
