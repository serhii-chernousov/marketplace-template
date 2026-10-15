import { OnModuleInit } from '@nestjs/common'
import {
	ConnectedSocket,
	MessageBody,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer,
} from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { OrderEventsService } from './order-events.service'
import { OrdersService, canonicalOrderId } from './orders.service'
import { ProblemException } from '../types/problem.exception'

@WebSocketGateway({ cors: { origin: '*' } })
export class OrdersGateway implements OnModuleInit {
	@WebSocketServer()
	server!: Server

	constructor(
		private readonly orders: OrdersService,
		private readonly orderEvents: OrderEventsService,
	) {}

	onModuleInit(): void {
		this.orderEvents.allChanges$().subscribe((event) => {
			this.server.to(`orders:${event.orderId}`).emit('order.status', {
				id: event.orderId,
				status: event.status,
				eventId: event.id,
			})
		})
	}

	@SubscribeMessage('join')
	async join(
		@ConnectedSocket() client: Socket,
		@MessageBody() orderId: string,
	): Promise<{ ok: true; room: string } | { ok: false; error: string }> {
		const userId = String(client.handshake.auth?.userId ?? '')
		const role = String(client.handshake.auth?.role ?? '')
		const canonical = canonicalOrderId(String(orderId ?? ''))

		try {
			await this.orders.assertCanRead(canonical, userId, role)
		} catch (err: unknown) {
			const message =
				err instanceof ProblemException
					? err.body.detail
					: err instanceof Error
						? err.message
						: 'Forbidden'
			return { ok: false, error: message }
		}

		const room = `orders:${canonical}`
		await client.join(room)
		return { ok: true, room }
	}
}
