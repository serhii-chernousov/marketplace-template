import type { Channel } from 'amqplib'

/** Prefetch × ~20ms INSERT ≪ 30min consumer_timeout. */
export const PREFETCH = 20

export const EVENTS_EXCHANGE = 'shop.events'
export const DLX_EXCHANGE = 'shop.events.dlx'
export const ORDER_PLACED_QUEUE = 'shop.order.placed'
export const ORDER_PLACED_DLQ = 'shop.order.placed.dlq'
export const ORDER_PLACED_KEY = 'order.placed'

/**
 * Declares exchange + queue + binding + DLX/DLQ.
 * Call from consumer/bootstrap — producers must not know who listens.
 * Queue arguments are immutable: demos delete queues before re-asserting.
 */
export async function assertTopology(channel: Channel): Promise<void> {
	await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true })
	await channel.assertExchange(DLX_EXCHANGE, 'fanout', { durable: true })

	await channel.assertQueue(ORDER_PLACED_DLQ, { durable: true })
	await channel.bindQueue(ORDER_PLACED_DLQ, DLX_EXCHANGE, '')

	await channel.assertQueue(ORDER_PLACED_QUEUE, {
		durable: true,
		arguments: {
			'x-queue-type': 'quorum',
			'x-dead-letter-exchange': DLX_EXCHANGE,
		},
	})
	await channel.bindQueue(
		ORDER_PLACED_QUEUE,
		EVENTS_EXCHANGE,
		ORDER_PLACED_KEY,
	)

	await channel.prefetch(PREFETCH)
}

/**
 * Drop work + DLQ so assertTopology can set fresh x-arguments.
 * Safe when queues do not exist yet.
 */
export async function resetQueues(channel: Channel): Promise<void> {
	try {
		await channel.deleteQueue(ORDER_PLACED_QUEUE)
	} catch {
		/* queue missing */
	}
	try {
		await channel.deleteQueue(ORDER_PLACED_DLQ)
	} catch {
		/* queue missing */
	}
}
