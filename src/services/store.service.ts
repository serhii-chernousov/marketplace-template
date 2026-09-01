import { Injectable } from '@nestjs/common'
import { createHash, randomUUID } from 'crypto'

export interface Listing {
	id: string
	title: string
	price_cents: number
	status: 'active' | 'archived'
	seller_id: string
	quantity: number
}

export interface OrderItem {
	listing_id: string
	quantity: number
	price_cents: number
}

export interface Order {
	id: string
	buyer_id: string
	seller_id: string
	items: OrderItem[]
	total_cents: number
	status: 'created' | 'paid' | 'cancelled'
}

interface IdempotencyRecord {
	bodyHash: string
	location: string
	body: Order
}

@Injectable()
export class StoreService {
	readonly listings = new Map<string, Listing>()
	readonly orders = new Map<string, Order>()
	readonly idempotencyStore = new Map<string, IdempotencyRecord>()

	constructor() {
		this.listings.set('listing-1', {
			id: 'listing-1',
			title: 'Vintage lamp',
			price_cents: 2500,
			status: 'active',
			seller_id: 'seller-1',
			quantity: 5,
		})
		this.listings.set('listing-2', {
			id: 'listing-2',
			title: 'Ceramic mug',
			price_cents: 900,
			status: 'active',
			seller_id: 'seller-1',
			quantity: 10,
		})
		this.listings.set('listing-3', {
			id: 'listing-3',
			title: 'Archived chair',
			price_cents: 4000,
			status: 'archived',
			seller_id: 'seller-2',
			quantity: 1,
		})
	}

	toPublicListing(listing: Listing) {
		return {
			id: listing.id,
			title: listing.title,
			price_cents: listing.price_cents,
			status: listing.status,
			seller_id: listing.seller_id,
		}
	}

	paginate<T extends { id: string }>(
		items: T[],
		limit?: number,
		cursor?: string,
	) {
		const pageSize = limit ?? 20
		let start = 0
		if (cursor) {
			const idx = items.findIndex((item) => item.id === cursor)
			start = idx >= 0 ? idx + 1 : 0
		}
		const slice = items.slice(start, start + pageSize)
		const last = slice[slice.length - 1]
		const hasMore = start + pageSize < items.length
		return {
			items: slice,
			next_cursor: hasMore && last ? last.id : null,
		}
	}

	newListingId() {
		return `listing-${randomUUID()}`
	}

	newOrderId() {
		return `order-${randomUUID()}`
	}

	hashBody(body: unknown) {
		return createHash('sha256').update(JSON.stringify(body)).digest('hex')
	}
}
