import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib'
import { EffectStore } from './effect-store'
import { OrderPlacedEvent } from './order-placed.event'
import { ORDER_PLACED_QUEUE } from './topology'

export interface ConsumerHandle {
	connection: ChannelModel
	channel: Channel
	consumerTag: string
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
					channel.reject(msg, false)
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
				channel.reject(msg, false)
			}
		},
		{ noAck: false },
	)

	return { connection, channel, consumerTag }
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
