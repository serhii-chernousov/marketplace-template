import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	Query,
	Res,
} from '@nestjs/common'
import { Response } from 'express'
import { DataSource } from 'typeorm'
import type { AuthUser } from '../auth/auth-user'
import { CurrentUser, Public, Roles } from '../auth/decorators'
import { forbidden } from '../auth/problems'
import { publicUserIdOf } from '../common/public-user-id'
import { ProblemException } from '../types/problem.exception'
import { StoreService } from '../store/store.service'

@Controller('v1/listings')
export class ListingsController {
	constructor(
		private readonly store: StoreService,
		private readonly dataSource: DataSource,
	) {}

	@Public()
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

	@Public()
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
	@Roles('seller')
	async create(
		@CurrentUser() user: AuthUser,
		@Body() body: { title: string; price_cents: number; quantity: number },
		@Res({ passthrough: true }) res: Response,
	) {
		const sellerId = await publicUserIdOf(this.dataSource, user.id)
		const id = this.store.newListingId()
		const listing = {
			id,
			title: body.title,
			price_cents: body.price_cents,
			quantity: body.quantity,
			status: 'active' as const,
			seller_id: sellerId,
		}
		this.store.listings.set(id, listing)
		res.setHeader('Location', `/v1/listings/${id}`)
		return listing
	}

	@Patch(':id')
	@Roles('seller')
	async update(
		@Param('id') id: string,
		@CurrentUser() user: AuthUser,
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

		if (
			listing.seller_id !== (await publicUserIdOf(this.dataSource, user.id))
		) {
			throw forbidden(
				'Only the listing owner can update it',
				`/v1/listings/${id}`,
			)
		}

		Object.assign(listing, body)
		return listing
	}
}
