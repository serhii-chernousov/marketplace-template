import {
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Param,
	Patch,
	Post,
	Query,
	Res,
} from '@nestjs/common'
import { Response } from 'express'
import { ProblemException } from '../types/problem.exception'
import { StoreService } from '../store/store.service'

@Controller('v1/listings')
export class ListingsController {
	constructor(private readonly store: StoreService) {}

	@Get()
	list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
		const active = [...this.store.listings.values()]
			.filter((l) => l.status === 'active')
			.map((l) => this.store.toPublicListing(l))
		return this.store.paginate(
			active,
			limit ? Number(limit) : undefined,
			cursor,
		)
	}

	@Get(':id')
	getById(@Param('id') id: string) {
		const listing = this.store.listings.get(id)
		if (!listing) {
			throw new ProblemException(
				404,
				'https://marketplace.local/problems/listing-not-found',
				'Listing not found',
				'Listing with the given id does not exist',
				`/v1/listings/${id}`,
			)
		}
		return this.store.toPublicListing(listing)
	}

	@Post()
	@HttpCode(201)
	create(
		@Headers('x-user-id') userId: string,
		@Headers('x-user-role') role: string,
		@Body() body: { title: string; price_cents: number; quantity: number },
		@Res({ passthrough: true }) res: Response,
	) {
		if (role !== 'seller') {
			throw new ProblemException(
				403,
				'https://marketplace.local/problems/forbidden',
				'Forbidden',
				'Only sellers can create listings',
				'/v1/listings',
			)
		}

		const id = this.store.newListingId()
		const listing = {
			id,
			title: body.title,
			price_cents: body.price_cents,
			quantity: body.quantity,
			status: 'active' as const,
			seller_id: userId,
		}
		this.store.listings.set(id, listing)
		res.setHeader('Location', `/v1/listings/${id}`)
		return listing
	}

	@Patch(':id')
	update(
		@Param('id') id: string,
		@Headers('x-user-id') userId: string,
		@Headers('x-user-role') role: string,
		@Body()
		body: Partial<{
			title: string
			price_cents: number
			quantity: number
			status: 'active' | 'archived'
		}>,
	) {
		const listing = this.store.listings.get(id)
		if (!listing) {
			throw new ProblemException(
				404,
				'https://marketplace.local/problems/listing-not-found',
				'Listing not found',
				'Listing with the given id does not exist',
				`/v1/listings/${id}`,
			)
		}

		if (role !== 'seller' || listing.seller_id !== userId) {
			throw new ProblemException(
				403,
				'https://marketplace.local/problems/forbidden',
				'Forbidden',
				'Only the listing owner can update it',
				`/v1/listings/${id}`,
			)
		}

		Object.assign(listing, body)
		return listing
	}
}
