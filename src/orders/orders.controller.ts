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
import { OrdersService } from './orders.service'

@Controller('v1/orders')
export class OrdersController {
	constructor(private readonly orders: OrdersService) {}

	@Get()
	list(
		@Headers('x-user-id') userId: string,
		@Headers('x-user-role') role: string,
		@Query('limit') limit?: string,
		@Query('cursor') cursor?: string,
	) {
		return this.orders.list(
			userId,
			role,
			limit ? Number(limit) : undefined,
			cursor,
		)
	}

	@Post()
	@HttpCode(201)
	async create(
		@Headers('x-user-id') userId: string,
		@Headers('x-user-role') role: string,
		@Headers('idempotency-key') idempotencyKey: string,
		@Body() body: { items: Array<{ listing_id: string; quantity: number }> },
		@Res({ passthrough: true }) res: Response,
	) {
		const result = await this.orders.create(
			userId,
			role,
			idempotencyKey,
			body,
		)
		res.setHeader('Location', result.location)
		if (result.replay) {
			res.setHeader('Idempotency-Replay', 'true')
		}
		return result.order
	}

	@Get(':id')
	getById(
		@Param('id') id: string,
		@Headers('x-user-id') userId: string,
		@Headers('x-user-role') role: string,
	) {
		return this.orders.getById(id, userId, role)
	}
}
