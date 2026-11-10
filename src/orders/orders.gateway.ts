import { OnModuleInit } from '@nestjs/common'
import {
	ConnectedSocket,
	MessageBody,
	OnGatewayInit,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer,
} from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { AccessTokenService } from '../auth/access-token.service'
import type { AuthUser } from '../auth/auth-user'
import { DenyList } from '../auth/deny-list'
import { OrderEventsService } from './order-events.service'
import { OrdersService, canonicalOrderId } from './orders.service'
import { ProblemException } from '../types/problem.exception'

@WebSocketGateway({ cors: { origin: '*' } })
export class OrdersGateway implements OnModuleInit, OnGatewayInit {
	@WebSocketServer()
	server!: Server

	constructor(
		private readonly orders: OrdersService,
		private readonly orderEvents: OrderEventsService,
		private readonly accessTokens: AccessTokenService,
		private readonly denyList: DenyList,
	) {}

	/**
	 * Global HTTP guards do not run on gateways, and Nest does not await
	 * handleConnection before dispatching messages — so the token is checked
	 * in socket.io middleware, before the connection is accepted at all.
	 */
	afterInit(server: Server): void {
		server.use((socket, next) => {
			this.authenticate(String(socket.handshake.auth?.token ?? ''))
				.then((user) => {
					socket.data.user = user
					next()
				})
				.catch(() => next(new Error('Unauthorized')))
		})
	}

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
		const user = client.data.user as AuthUser
		const canonical = canonicalOrderId(String(orderId ?? ''))

		try {
			await this.orders.assertCanRead(canonical, user)
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

	private async authenticate(token: string): Promise<AuthUser> {
		const user = await this.accessTokens.verify(token)
		if (await this.denyList.isDenied(user.jti, user.sid)) {
			throw new Error('revoked')
		}
		return user
	}
}
