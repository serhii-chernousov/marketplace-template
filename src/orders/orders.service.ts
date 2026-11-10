import { Injectable } from '@nestjs/common'
import { DataSource, ILike } from 'typeorm'
import {
	CheckoutService,
	IdempotencyKeyConflictError,
	InsufficientFundsError,
	OutOfStockError,
} from '../checkout/checkout.service'
import { Order as OrderRow } from '../entities/order.entity'
import { Product } from '../entities/product.entity'
import type { AuthUser } from '../auth/auth-user'
import { publicUserId, publicUserIdOf } from '../common/public-user-id'
import { RatingQueueService } from '../queue/rating-queue.service'
import { User } from '../entities/user.entity'
import { ProblemException } from '../types/problem.exception'
import { Order, StoreService } from '../store/store.service'
import { OrderEventsService } from './order-events.service'

const ALLOWED_STATUSES: ReadonlySet<string> = new Set([
	'pending',
	'paid',
	'shipped',
	'delivered',
	'cancelled',
])

export function canonicalOrderId(id: string): string {
	const match = /^order-(\d+)$/.exec(id)
	if (match) {
		return `order-${match[1]}`
	}
	if (/^\d+$/.test(id)) {
		return `order-${id}`
	}
	return id
}

export function toDbOrderId(id: string): string {
	return /^order-(\d+)$/.exec(id)?.[1] ?? id
}

@Injectable()
export class OrdersService {
	constructor(
		private readonly store: StoreService,
		private readonly checkout: CheckoutService,
		private readonly dataSource: DataSource,
		private readonly orderEvents: OrderEventsService,
		private readonly ratings: RatingQueueService,
	) {}

	async list(caller: AuthUser, limit?: number, cursor?: string) {
		let filtered = [...this.store.orders.values()]

		if (caller.role !== 'admin') {
			const me = await publicUserIdOf(this.dataSource, caller.id)
			filtered = filtered.filter((o) =>
				caller.role === 'buyer' ? o.buyer_id === me : o.seller_id === me,
			)
		}

		return this.store.paginate(filtered, limit, cursor)
	}

	async getById(id: string, caller: AuthUser): Promise<Order> {
		const { order } = await this.loadAuthorizedOrder(id, caller)
		return order
	}

	/**
	 * Throws 404/403 if the caller cannot read the order.
	 * Used by WebSocket join and SSE — same ownership rules as GET /v1/orders/:id.
	 */
	async assertCanRead(id: string, caller: AuthUser): Promise<void> {
		await this.loadAuthorizedOrder(id, caller)
	}

	async updateStatus(
		id: string,
		caller: AuthUser,
		status: string,
	): Promise<{ id: string; status: string }> {
		if (!ALLOWED_STATUSES.has(status)) {
			throw new ProblemException(
				400,
				'https://marketplace.local/problems/invalid-status',
				'Invalid status',
				`Status must be one of: ${[...ALLOWED_STATUSES].join(', ')}`,
				`/orders/${id}/status`,
			)
		}

		const { canonicalId, row } = await this.loadAuthorizedOrder(
			id,
			caller,
			`/orders/${id}/status`,
		)

		await this.dataSource.transaction(async (manager) => {
			await manager.query(`UPDATE orders SET status = $1 WHERE id = $2`, [
				status,
				row.id,
			])
		})

		this.orderEvents.publish(canonicalId, status)
		return { id: canonicalId, status }
	}

	async create(
		caller: AuthUser,
		idempotencyKey: string,
		body: { items: Array<{ listing_id: string; quantity: number }> },
	): Promise<{ order: Order; location: string; replay: boolean }> {
		const bodyHash = this.store.hashBody(body)
		const cacheKey = `${caller.id}:${idempotencyKey}`
		const cached = this.store.idempotencyStore.get(cacheKey)
		if (cached) {
			if (cached.bodyHash !== bodyHash) {
				throw new ProblemException(
					422,
					'https://marketplace.local/problems/idempotency-key-conflict',
					'Idempotency key conflict',
					'Same Idempotency-Key was reused with a different request body',
					'/v1/orders',
				)
			}
			return {
				order: cached.body,
				location: cached.location,
				replay: true,
			}
		}

		const resolved: Array<{
			listing_id: string
			quantity: number
			price_cents: number
			productId: string
			seller_id: string
		}> = []
		let sellerId: string | null = null

		for (const item of body.items) {
			const listing = this.store.listings.get(item.listing_id)
			if (!listing || listing.status !== 'active') {
				throw new ProblemException(
					404,
					'https://marketplace.local/problems/listing-not-found',
					'Listing not found',
					`Listing ${item.listing_id} does not exist or is not active`,
					'/v1/orders',
				)
			}
			if (sellerId === null) {
				sellerId = listing.seller_id
			} else if (sellerId !== listing.seller_id) {
				throw new ProblemException(
					422,
					'https://marketplace.local/problems/mixed-seller-order',
					'Mixed seller order',
					'All order items must belong to the same seller',
					'/v1/orders',
				)
			}

			const product = await this.dataSource.getRepository(Product).findOne({
				where: { name: ILike(listing.title), isActive: true },
			})
			if (!product) {
				throw new ProblemException(
					404,
					'https://marketplace.local/problems/listing-not-found',
					'Listing not found',
					`No catalog product matches listing ${item.listing_id}`,
					'/v1/orders',
				)
			}

			resolved.push({
				listing_id: listing.id,
				quantity: item.quantity,
				price_cents: product.priceCents,
				productId: product.id,
				seller_id: listing.seller_id,
			})
		}

		const buyer = await this.dataSource
			.getRepository(User)
			.findOne({ where: { id: caller.id, role: 'buyer', isActive: true } })
		if (!buyer) {
			throw new ProblemException(
				403,
				'https://marketplace.local/problems/forbidden',
				'Forbidden',
				'Only an active buyer account can place orders',
				'/v1/orders',
			)
		}

		let result
		try {
			result = await this.checkout.checkout({
				userId: buyer.id,
				items: resolved.map((item) => ({
					productId: item.productId,
					quantity: item.quantity,
				})),
				idempotencyKey,
				requestHash: bodyHash,
			})
		} catch (err: unknown) {
			if (err instanceof IdempotencyKeyConflictError) {
				throw new ProblemException(
					422,
					'https://marketplace.local/problems/idempotency-key-conflict',
					'Idempotency key conflict',
					'Same Idempotency-Key was reused with a different request body',
					'/v1/orders',
				)
			}
			if (err instanceof OutOfStockError) {
				throw new ProblemException(
					409,
					'https://marketplace.local/problems/out-of-stock',
					'Out of stock',
					'One or more listings do not have enough quantity',
					'/v1/orders',
				)
			}
			if (err instanceof InsufficientFundsError) {
				throw new ProblemException(
					409,
					'https://marketplace.local/problems/out-of-stock',
					'Out of stock',
					'Insufficient buyer balance for this order',
					'/v1/orders',
				)
			}
			throw err
		}

		if (result.replay) {
			const { order } = await this.loadAuthorizedOrder(
				`order-${result.orderId}`,
				caller,
			)
			const location = `/v1/orders/${order.id}`
			this.store.idempotencyStore.set(cacheKey, {
				bodyHash,
				location,
				body: order,
			})
			return { order, location, replay: true }
		}

		// Order and outbox row committed together. Relay publishes later.
		for (const item of resolved) {
			const listing = this.store.listings.get(item.listing_id)
			if (listing) {
				listing.quantity = Math.max(0, listing.quantity - item.quantity)
			}
		}

		const orderItems = resolved.map((item, index) => ({
			listing_id: item.listing_id,
			quantity: item.quantity,
			price_cents: result.unitPrices[index] ?? item.price_cents,
		}))
		const id = `order-${result.orderId}`
		const order: Order = {
			id,
			buyer_id: publicUserId(buyer.email),
			seller_id: sellerId as string,
			items: orderItems,
			total_cents: result.totalCents,
			status: 'paid',
		}
		this.store.orders.set(id, order)
		this.ratings.enqueueRecalcInBackground(
			result.orderId,
			resolved.map((item) => item.productId),
		)

		const location = `/v1/orders/${id}`
		this.store.idempotencyStore.set(cacheKey, {
			bodyHash,
			location,
			body: order,
		})

		return { order, location, replay: false }
	}

	/**
	 * Ownership is decided here, after the row is loaded, not in a guard: a guard
	 * runs before the resource exists for it. Unknown id → 404, foreign → 403.
	 */
	private async loadAuthorizedOrder(
		id: string,
		caller: AuthUser,
		instancePath?: string,
	): Promise<{
		canonicalId: string
		order: Order
		row: OrderRow
	}> {
		const instance = instancePath ?? `/v1/orders/${id}`
		const dbId = toDbOrderId(id)
		const rows = await this.dataSource
			.getRepository(OrderRow)
			.createQueryBuilder('ord')
			.leftJoinAndSelect('ord.user', 'buyer')
			.leftJoinAndSelect('ord.items', 'item')
			.leftJoinAndSelect('item.product', 'product')
			.leftJoinAndSelect('product.seller', 'seller')
			.where('CAST(ord.id AS text) = :dbId', { dbId })
			.getMany()
		const row = rows[0]
		row?.items?.sort((left, right) =>
			left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
		)

		const seller = row?.items[0]?.product?.seller
		if (!row?.user || !row.items?.length || !seller) {
			throw new ProblemException(
				404,
				'https://marketplace.local/problems/order-not-found',
				'Order not found',
				'Order with the given id does not exist',
				instance,
			)
		}

		const order = this.toApiOrder(row, seller)
		if (!callerCanRead(caller, row.user, seller)) {
			throw new ProblemException(
				403,
				'https://marketplace.local/problems/forbidden',
				'Forbidden',
				'You do not have access to this order',
				instance,
			)
		}

		return {
			canonicalId: canonicalOrderId(id),
			order,
			row,
		}
	}

	private toApiOrder(row: OrderRow, seller: User): Order {
		const status: Order['status'] =
			row.status === 'paid' || row.status === 'cancelled'
				? row.status
				: 'created'
		return {
			id: `order-${row.id}`,
			buyer_id: publicUserId(row.user.email),
			seller_id: publicUserId(seller.email),
			items: row.items.map((item) => ({
				listing_id: this.listingIdForProduct(item.product.name),
				quantity: item.quantity,
				price_cents: item.unitPriceCents,
			})),
			total_cents: row.totalCents,
			status,
		}
	}

	private listingIdForProduct(name: string): string {
		const needle = name.toLowerCase()
		for (const listing of this.store.listings.values()) {
			if (listing.title.toLowerCase() === needle) {
				return listing.id
			}
		}
		return name
	}
}

function callerCanRead(caller: AuthUser, buyer: User, seller: User): boolean {
	switch (caller.role) {
		case 'admin':
			return true
		case 'buyer':
			return caller.id === buyer.id
		case 'seller':
			return caller.id === seller.id
	}
}
