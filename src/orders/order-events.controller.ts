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
 * Realtime HTTP surface (outside /v1 OpenAPI contract).
 * GET /orders/:id/events — SSE; PATCH /orders/:id/status — status mutation + bus publish.
 */
@Controller('orders')
export class OrderEventsController {
	constructor(
		private readonly orders: OrdersService,
		private readonly orderEvents: OrderEventsService,
	) {}

	@Get(':id/events')
	streamEvents(
		@Param('id') id: string,
		@Headers('last-event-id') lastEventIdHeader: string | undefined,
		@Req() req: Request,
		@Res() res: Response,
	): void {
		const orderId = canonicalOrderId(id)
		const lastEventId = Number(lastEventIdHeader ?? 0) || 0

		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		})
		res.write('retry: 1000\n\n')

		for (const event of this.orderEvents.replayAfter(orderId, lastEventId)) {
			writeSseFrame(res, event)
		}

		const subscription = this.orderEvents.changes$(orderId).subscribe((event) => {
			writeSseFrame(res, event)
		})

		req.on('close', () => {
			subscription.unsubscribe()
		})
	}

	@Patch(':id/status')
	updateStatus(
		@Param('id') id: string,
		@Headers('x-user-id') userId: string,
		@Headers('x-user-role') role: string,
		@Body() body: { status: string },
	) {
		return this.orders.updateStatus(id, userId, role, body.status)
	}
}
