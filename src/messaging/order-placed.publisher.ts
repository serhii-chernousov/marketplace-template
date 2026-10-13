import {
	connectBroker,
	createConfirmChannel,
	requireBrokerUrl,
} from './broker'
import { OrderPlacedEvent } from './order-placed.event'
import { EVENTS_EXCHANGE, ORDER_PLACED_KEY } from './topology'

/**
 * Publishes order.placed with a confirm channel.
 * Does not declare queues — producer must not know consumers.
 * Confirm means broker accepted the publish, not that a binding matched.
 */
export async function publishOrderPlaced(
	event: OrderPlacedEvent,
): Promise<void> {
	const url = requireBrokerUrl()
	const connection = await connectBroker(url)
	try {
		const channel = await createConfirmChannel(connection)
		try {
			const body = Buffer.from(JSON.stringify(event), 'utf8')
			channel.publish(EVENTS_EXCHANGE, ORDER_PLACED_KEY, body, {
				persistent: true,
				contentType: 'application/json',
				messageId: event.eventId,
			})
			await channel.waitForConfirms()
		} finally {
			await channel.close()
		}
	} finally {
		await connection.close()
	}
}
