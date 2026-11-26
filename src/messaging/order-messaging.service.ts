import {
	Injectable,
	OnApplicationBootstrap,
	OnModuleDestroy,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DataSource } from 'typeorm'
import type { ApiEnv } from '../config/env.schema'
import { logger } from '../observability/logger'
import { OrderEventsService } from '../orders/order-events.service'
import { connectBroker, createChannel } from './broker'
import { EffectStore } from './effect-store'
import {
	ConsumerHandle,
	startOrderPlacedConsumer,
	stopConsumer,
} from './order-placed.consumer'
import { OrderPlacedEvent } from './order-placed.event'
import { OutboxRelay } from './outbox-relay'
import { assertTopology } from './topology'

const log = logger.child({ layer: 'messaging' })

const RECONNECT_MS = 2000

/**
 * Runs the outbox relay loop and the order.placed consumer inside the API
 * process, so the consumer can push the status change to this process's
 * realtime subscribers. Several replicas compete safely: the relay claims rows
 * with SKIP LOCKED and the consumer dedups by event id in Postgres.
 */
@Injectable()
export class OrderMessagingService
	implements OnApplicationBootstrap, OnModuleDestroy
{
	private consumer?: ConsumerHandle
	private relayTimer?: NodeJS.Timeout
	private reconnectTimer?: NodeJS.Timeout
	private stopped = false
	private relayStarted = false
	private readonly relay: OutboxRelay
	private readonly effects: EffectStore

	constructor(
		dataSource: DataSource,
		private readonly config: ConfigService<ApiEnv, true>,
		private readonly orderEvents: OrderEventsService,
	) {
		this.relay = new OutboxRelay(dataSource)
		this.effects = new EffectStore(dataSource)
	}

	onApplicationBootstrap(): void {
		if (this.config.get('MESSAGING_ENABLED', { infer: true }) === '0') {
			log.info('messaging disabled')
			return
		}
		// Not awaited: the API must boot and serve reads while the broker is down.
		void this.connectConsumer()
	}

	async onModuleDestroy(): Promise<void> {
		this.stopped = true
		clearTimeout(this.relayTimer)
		clearTimeout(this.reconnectTimer)
		if (this.consumer) {
			await stopConsumer(this.consumer)
		}
	}

	private async connectConsumer(): Promise<void> {
		try {
			const connection = await connectBroker()
			const channel = await createChannel(connection)
			await assertTopology(channel)
			// Publishing before the queue is bound drops the event while the
			// outbox row is still marked published, so the relay waits for this.
			this.startRelayOnce()
			connection.on('close', () => this.scheduleReconnect())
			connection.on('error', (err: unknown) =>
				log.warn({ err }, 'broker connection error'),
			)
			this.consumer = await startOrderPlacedConsumer(
				connection,
				channel,
				this.effects,
				(event) => this.onPaid(event),
			)
			log.info('order.placed consumer started')
		} catch (err) {
			log.warn({ err }, 'order.placed consumer failed to start')
			this.scheduleReconnect()
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped) {
			return
		}
		this.consumer = undefined
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = setTimeout(
			() => void this.connectConsumer(),
			RECONNECT_MS,
		)
	}

	private onPaid(event: OrderPlacedEvent): void {
		log.info({ orderId: event.orderId, eventId: event.eventId }, 'order paid')
		this.orderEvents.publish(event.orderId, 'paid')
	}

	private startRelayOnce(): void {
		if (this.relayStarted) {
			return
		}
		this.relayStarted = true
		this.scheduleRelay()
	}

	private scheduleRelay(): void {
		if (this.stopped) {
			return
		}
		this.relayTimer = setTimeout(
			() => void this.relayOnce(),
			this.config.get('OUTBOX_POLL_MS', { infer: true }),
		)
	}

	private async relayOnce(): Promise<void> {
		try {
			const published = await this.relay.publishPending()
			if (published > 0) {
				log.info({ published }, 'outbox relayed')
			}
		} catch (err) {
			log.warn({ err }, 'outbox relay failed')
		} finally {
			this.scheduleRelay()
		}
	}
}
