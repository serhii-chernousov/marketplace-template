import {
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Param,
	Post,
	Query,
	Res,
} from '@nestjs/common'
import { Response } from 'express'
import { ProblemException } from './problem.exception'
import { StoreService } from './store.service'

@Controller('v1/orders')
export class OrdersController {
	constructor(private readonly store: StoreService) {}

	@Get()
	list(
		@Headers('x-user-id') userId: string,
		@Headers('x-user-role') role: string,
		@Query('limit') limit?: string,
		@Query('cursor') cursor?: string,
	) {
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

		return this.store.paginate(
			filtered,
			limit ? Number(limit) : undefined,
			cursor,
		)
	}

	@Post()
	@HttpCode(201)
	create(
		@Headers('x-user-id') userId: string,
		@Headers('x-user-role') role: string,
		@Headers('idempotency-key') idempotencyKey: string,
		@Body() body: { items: Array<{ listing_id: string; quantity: number }> },
		@Res({ passthrough: true }) res: Response,
	) {
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
			res.setHeader('Location', cached.location)
			res.setHeader('Idempotency-Replay', 'true')
			return cached.body
		}

		const resolvedItems: Array<{
			listing_id: string
			quantity: number
			price_cents: number
			listingId: string
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
			if (listing.quantity < item.quantity) {
				throw new ProblemException(
					409,
					'https://marketplace.local/problems/out-of-stock',
					'Out of stock',
					'One or more listings do not have enough quantity',
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
			resolvedItems.push({
				listing_id: listing.id,
				quantity: item.quantity,
				price_cents: listing.price_cents,
				listingId: listing.id,
			})
		}

		for (const item of resolvedItems) {
			const listing = this.store.listings.get(item.listingId)!
			listing.quantity -= item.quantity
		}

		const orderItems = resolvedItems.map(({ listing_id, quantity, price_cents }) => ({
			listing_id,
			quantity,
			price_cents,
		}))
		const total_cents = orderItems.reduce(
			(sum, item) => sum + item.price_cents * item.quantity,
			0,
		)
		const id = this.store.newOrderId()
		const order = {
			id,
			buyer_id: userId,
			seller_id: sellerId as string,
			items: orderItems,
			total_cents,
			status: 'created' as const,
		}
		this.store.orders.set(id, order)

		const location = `/v1/orders/${id}`
		this.store.idempotencyStore.set(cacheKey, {
			bodyHash,
			location,
			body: order,
		})

		res.setHeader('Location', location)
		return order
	}

	@Get(':id')
	getById(
		@Param('id') id: string,
		@Headers('x-user-id') userId: string,
		@Headers('x-user-role') role: string,
	) {
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
}
