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
import type { AuthUser } from '../auth/auth-user'
import { CurrentUser, Roles } from '../auth/decorators'
import { RateLimit } from '../ratelimit/rate-limit.decorator'
import { OrdersService } from './orders.service'

@Controller('v1/orders')
export class OrdersController {
	constructor(private readonly orders: OrdersService) {}

	@Get()
	list(
		@CurrentUser() user: AuthUser,
		@Query('limit') limit?: string,
		@Query('cursor') cursor?: string,
	) {
		return this.orders.list(user, limit ? Number(limit) : undefined, cursor)
	}

	@Post()
	@HttpCode(201)
	@Roles('buyer')
	@RateLimit({ limit: 10, windowMs: 60_000 })
	async create(
		@CurrentUser() user: AuthUser,
		@Headers('idempotency-key') idempotencyKey: string,
		@Body() body: { items: Array<{ listing_id: string; quantity: number }> },
		@Res({ passthrough: true }) res: Response,
	) {
		const result = await this.orders.create(user, idempotencyKey, body)
		res.setHeader('Location', result.location)
		if (result.replay) {
			res.setHeader('Idempotency-Replay', 'true')
		}
		return result.order
	}

	@Get(':id')
	getById(@Param('id') id: string, @CurrentUser() user: AuthUser) {
		return this.orders.getById(id, user)
	}
}
