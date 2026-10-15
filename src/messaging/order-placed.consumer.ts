import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib'
import { readPgCode } from '../common/with-retry'
import { EffectStore } from './effect-store'
import { OrderPlacedEvent } from './order-placed.event'
import { ORDER_PLACED_QUEUE } from './topology'

export interface ConsumerHandle {
	connection: ChannelModel
	channel: Channel
	consumerTag: string
	/** Times this consumer called reject(msg, false). */
	rejected: number
}

const TRANSIENT_NODE = new Set([
	'EAI_AGAIN',
	'ECONNABORTED',
	'ECONNREFUSED',
	'ECONNRESET',
	'EHOSTUNREACH',
	'ENETDOWN',
	'ENETUNREACH',
	'ENOTFOUND',
	'EPIPE',
	'ETIMEDOUT',
])

const TRANSIENT_MESSAGE =
	/connection terminated|not queryable|could not connect to server|the database system is (starting up|shutting down)|sorry, too many clients already/i

function isTransientCode(code: string): boolean {
	if (TRANSIENT_NODE.has(code) || code === '55P03') {
		return true
	}
	return code.length === 5 && /^(08|40|53|57)/.test(code)
}

/**
 * DB blips and serialization conflicts must be requeued.
 * Bad payloads and data errors are permanent and belong in the DLQ.
 */
export function isTransientConsumerError(err: unknown): boolean {
	const seen = new Set<unknown>()
	const visit = (current: unknown): boolean => {
		if (!current || typeof current !== 'object' || seen.has(current)) {
			return false
		}
		seen.add(current)
		const code = readPgCode(current)
		if (code && isTransientCode(code)) {
			return true
		}
		if (current instanceof Error && TRANSIENT_MESSAGE.test(current.message)) {
			return true
		}
		const nested = current as { cause?: unknown; driverError?: unknown }
		return visit(nested.driverError) || visit(nested.cause)
	}
	return visit(err)
}

function parseEvent(msg: ConsumeMessage): OrderPlacedEvent {
	const raw = JSON.parse(msg.content.toString('utf8')) as OrderPlacedEvent
	if (
		typeof raw.eventId !== 'string' ||
		raw.type !== 'order.placed' ||
		typeof raw.orderId !== 'string'
	) {
		throw new Error('Invalid order.placed payload')
	}
	return raw
}

/**
 * Manual-ack consumer. Order per message:
 * 1) record delivery 2) poison → reject 3) apply effect
 * 4) optional SIGKILL before ack 5) ack then markAcked
 */
export async function startOrderPlacedConsumer(
	connection: ChannelModel,
	channel: Channel,
	store: EffectStore,
): Promise<ConsumerHandle> {
	const crashBeforeAck = process.env.CRASH_BEFORE_ACK === '1'
	const handle: ConsumerHandle = {
		connection,
		channel,
		consumerTag: '',
		rejected: 0,
	}

	const rejectPermanent = (message: ConsumeMessage): void => {
		channel.reject(message, false)
		handle.rejected += 1
	}

	const { consumerTag } = await channel.consume(
		ORDER_PLACED_QUEUE,
		async (msg) => {
			if (!msg) {
				return
			}
			try {
				const event = parseEvent(msg)
				await store.recordDelivery(event.eventId)

				if (event.poison) {
					rejectPermanent(msg)
					return
				}

				const applied = await store.applyEffect(event)

				if (crashBeforeAck && applied) {
					process.kill(process.pid, 'SIGKILL')
					return
				}

				channel.ack(msg)
				await store.markAcked(event.eventId)
			} catch (err) {
				console.error('order.placed consumer error', err)
				if (isTransientConsumerError(err)) {
					channel.nack(msg, false, true)
					return
				}
				rejectPermanent(msg)
			}
		},
		{ noAck: false },
	)

	handle.consumerTag = consumerTag
	return handle
}

export async function stopConsumer(handle: ConsumerHandle): Promise<void> {
	try {
		await handle.channel.cancel(handle.consumerTag)
	} catch {
		/* already closed */
	}
	try {
		await handle.channel.close()
	} catch {
		/* already closed */
	}
	try {
		await handle.connection.close()
	} catch {
		/* already closed */
	}
}
