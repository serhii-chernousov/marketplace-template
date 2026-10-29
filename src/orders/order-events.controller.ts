import {
	Body,
	Controller,
	Get,
	Headers,
	Param,
	Patch,
	Req,
	Res,
} from '@nestjs/common'
import { Request, Response } from 'express'
import type { AuthUser } from '../auth/auth-user'
import { CurrentUser, Roles } from '../auth/decorators'
import { OrderEventsService, OrderStatusEvent } from './order-events.service'
import { OrdersService, canonicalOrderId } from './orders.service'

function writeSseFrame(res: Response, event: OrderStatusEvent): void {
	res.write(`id: ${event.id}\n`)
	res.write(`event: order.status\n`)
	res.write(
		`data: ${JSON.stringify({ id: event.orderId, status: event.status })}\n\n`,
	)
}

/**
 * Absent header replays the buffer from the start.
 * A non-negative integer is a cursor. Anything else means "from now" — no replay.
 */
export function parseLastEventId(header: string | undefined): number | null {
	if (header === undefined) {
		return 0
	}
	const value = header.trim()
	if (!/^(0|[1-9]\d*)$/.test(value)) {
		return null
	}
	const id = Number(value)
	if (!Number.isSafeInteger(id)) {
		return null
	}
	return id
}

/**
 * Realtime HTTP surface (outside /v1 OpenAPI contract).
 * GET /orders/:id/events — SSE; PATCH /orders/:id/status — status mutation + bus publish.
 * Both sit behind the global JWT guard, so an SSE client must send Authorization
 * (native EventSource cannot; a fetch-based client can).
 */
@Controller('orders')
export class OrderEventsController {
	constructor(
		private readonly orders: OrdersService,
		private readonly orderEvents: OrderEventsService,
	) {}

	@Get(':id/events')
	async streamEvents(
		@Param('id') id: string,
		@Headers('last-event-id') lastEventIdHeader: string | undefined,
		@CurrentUser() user: AuthUser,
		@Req() req: Request,
		@Res() res: Response,
	): Promise<void> {
		const orderId = canonicalOrderId(id)
		await this.orders.assertCanRead(orderId, user)

		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		})
		res.write('retry: 1000\n\n')

		const lastEventId = parseLastEventId(lastEventIdHeader)
		if (lastEventId !== null) {
			for (const event of this.orderEvents.replayAfter(orderId, lastEventId)) {
				writeSseFrame(res, event)
			}
		}

		const subscription = this.orderEvents
			.changes$(orderId)
			.subscribe((event) => {
				writeSseFrame(res, event)
			})

		req.on('close', () => {
			subscription.unsubscribe()
		})
	}

	@Patch(':id/status')
	@Roles('seller', 'admin')
	updateStatus(
		@Param('id') id: string,
		@CurrentUser() user: AuthUser,
		@Body() body: { status: string },
	) {
		return this.orders.updateStatus(id, user, body.status)
	}
}
