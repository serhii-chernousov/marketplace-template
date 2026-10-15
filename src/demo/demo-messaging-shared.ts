import { DataSource } from 'typeorm'
import {
	connectBroker,
	createChannel,
	createConfirmChannel,
} from '../messaging/broker'
import { EffectStore } from '../messaging/effect-store'
import { OrderPlacedEvent } from '../messaging/order-placed.event'
import {
	assertTopology,
	EVENTS_EXCHANGE,
	ORDER_PLACED_DLQ,
	ORDER_PLACED_KEY,
	ORDER_PLACED_QUEUE,
	resetQueues,
} from '../messaging/topology'
import base from '../database/data-source'
import type { Channel, ChannelModel } from 'amqplib'

export async function openDemoDb(): Promise<{
	ds: DataSource
	store: EffectStore
}> {
	const ds = new DataSource({ ...base.options })
	await ds.initialize()
	return { ds, store: new EffectStore(ds) }
}

export async function prepareBroker(): Promise<{
	connection: ChannelModel
	channel: Channel
}> {
	const connection = await connectBroker()
	const channel = await createChannel(connection)
	await resetQueues(channel)
	await assertTopology(channel)
	return { connection, channel }
}

export async function publishRaw(
	event: OrderPlacedEvent,
	connection: ChannelModel,
): Promise<void> {
	const channel = await createConfirmChannel(connection)
	try {
		channel.publish(
			EVENTS_EXCHANGE,
			ORDER_PLACED_KEY,
			Buffer.from(JSON.stringify(event), 'utf8'),
			{
				persistent: true,
				contentType: 'application/json',
				messageId: event.eventId,
			},
		)
		await channel.waitForConfirms()
	} finally {
		await channel.close()
	}
}

export async function queueDepth(
	channel: Channel,
	queue: string,
): Promise<number> {
	const info = await channel.checkQueue(queue)
	return info.messageCount
}

export async function waitUntil(
	predicate: () => Promise<boolean>,
	label: string,
	timeoutMs = 15_000,
	intervalMs = 50,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await predicate()) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs))
	}
	throw new Error(`Timeout waiting for ${label}`)
}

export { ORDER_PLACED_DLQ, ORDER_PLACED_QUEUE }
