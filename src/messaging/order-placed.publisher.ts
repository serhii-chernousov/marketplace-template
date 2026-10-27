import type { ConfirmChannel } from 'amqplib'
import { connectBroker, createConfirmChannel, requireBrokerUrl } from './broker'
import { OrderPlacedEvent } from './order-placed.event'
import { EVENTS_EXCHANGE, ORDER_PLACED_KEY } from './topology'

/**
 * Publishes order.placed on an already open confirm channel.
 * Does not declare queues — producer must not know consumers.
 * Confirm means broker accepted the publish, not that a binding matched.
 */
export async function publishOrderPlaced(
	event: OrderPlacedEvent,
	channel: ConfirmChannel,
): Promise<void> {
	const body = Buffer.from(JSON.stringify(event), 'utf8')
	channel.publish(EVENTS_EXCHANGE, ORDER_PLACED_KEY, body, {
		persistent: true,
		contentType: 'application/json',
		messageId: event.eventId,
	})
	await channel.waitForConfirms()
}

/**
 * One AMQP connection and confirm channel for a whole relay cycle.
 * The channel stays open across every publish in `run`, then closes.
 */
export async function withOrderPlacedChannel<T>(
	run: (channel: ConfirmChannel) => Promise<T>,
): Promise<T> {
	const connection = await connectBroker(requireBrokerUrl())
	let channel: ConfirmChannel
	try {
		channel = await createConfirmChannel(connection)
	} catch (err) {
		await connection.close()
		throw err
	}
	try {
		return await run(channel)
	} finally {
		try {
			await channel.close()
		} finally {
			await connection.close()
		}
	}
}
