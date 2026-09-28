import { Injectable } from '@nestjs/common'
import { DataSource, ILike } from 'typeorm'
import {
	CheckoutService,
	InsufficientFundsError,
	OutOfStockError,
} from '../checkout/checkout.service'
import { Product } from '../entities/product.entity'
import { User } from '../entities/user.entity'
import { ProblemException } from '../types/problem.exception'
import { Order, StoreService } from '../store/store.service'

/** OpenAPI demo headers → seed emails (ДЗ #09 curls stay valid). */
const USER_ALIASES: Record<string, string> = {
	'buyer-1': 'buyer1@shop.local',
	'buyer-2': 'buyer2@shop.local',
	'buyer-3': 'buyer3@shop.local',
	'buyer-4': 'buyer4@shop.local',
	'buyer-5': 'buyer5@shop.local',
	'seller-1': 'seller1@shop.local',
	'seller-2': 'seller2@shop.local',
}

@Injectable()
export class OrdersService {
	constructor(
		private readonly store: StoreService,
		private readonly checkout: CheckoutService,
		private readonly dataSource: DataSource,
	) {}

	list(userId: string, role: string, limit?: number, cursor?: string) {
		let filtered = [...this.store.orders.values()]

		if (role === 'buyer') {
			filtered = filtered.filter((o) => o.buyer_id === userId)
		} else if (role === 'seller') {
			filtered = filtered.filter((o) => o.seller_id === userId)
		} else {
			throw new ProblemException(
				403,
				'https://marketplace.local/problems/forbidden',
				'Forbidden',
				'Unknown role',
				'/v1/orders',
			)
		}

		return this.store.paginate(filtered, limit, cursor)
	}

	getById(id: string, userId: string, role: string): Order {
		const order = this.store.orders.get(id)
		if (!order) {
			throw new ProblemException(
				404,
				'https://marketplace.local/problems/order-not-found',
				'Order not found',
				'Order with the given id does not exist',
				`/v1/orders/${id}`,
			)
		}

		const allowed =
			(role === 'buyer' && order.buyer_id === userId) ||
			(role === 'seller' && order.seller_id === userId)

		if (!allowed) {
			throw new ProblemException(
				403,
				'https://marketplace.local/problems/forbidden',
				'Forbidden',
				'You do not have access to this order',
				`/v1/orders/${id}`,
			)
		}

		return order
	}

	async create(
		userId: string,
		role: string,
		idempotencyKey: string,
		body: { items: Array<{ listing_id: string; quantity: number }> },
	): Promise<{ order: Order; location: string; replay: boolean }> {
		if (role !== 'buyer') {
			throw new ProblemException(
				403,
				'https://marketplace.local/problems/forbidden',
				'Forbidden',
				'Only buyers can create orders',
				'/v1/orders',
			)
		}

		const bodyHash = this.store.hashBody(body)
		const cacheKey = `${userId}:${idempotencyKey}`
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

			const product = await this.dataSource
				.getRepository(Product)
				.findOne({
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

		const buyer = await this.resolveBuyer(userId)
		if (!buyer) {
			throw new ProblemException(
				403,
				'https://marketplace.local/problems/forbidden',
				'Forbidden',
				`Unknown buyer ${userId}; use seed alias (buyer-1) or email`,
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
			})
		} catch (err: unknown) {
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
			buyer_id: userId,
			seller_id: sellerId as string,
			items: orderItems,
			total_cents: result.totalCents,
			status: 'paid',
		}
		this.store.orders.set(id, order)

		const location = `/v1/orders/${id}`
		this.store.idempotencyStore.set(cacheKey, {
			bodyHash,
			location,
			body: order,
		})

		return { order, location, replay: false }
	}

	private async resolveBuyer(headerUserId: string): Promise<User | null> {
		const repo = this.dataSource.getRepository(User)
		const aliasEmail = USER_ALIASES[headerUserId]
		if (aliasEmail) {
			return repo.findOne({ where: { email: aliasEmail, role: 'buyer' } })
		}
		if (headerUserId.includes('@')) {
			return repo.findOne({
				where: { email: headerUserId, role: 'buyer' },
			})
		}
		if (/^\d+$/.test(headerUserId)) {
			return repo.findOne({
				where: { id: headerUserId, role: 'buyer' },
			})
		}
		return null
	}
}
