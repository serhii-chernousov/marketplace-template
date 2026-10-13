import {
	connectBroker,
	createChannel,
} from '../messaging/broker'
import { createOrderPlacedEvent } from '../messaging/order-placed.event'
import {
	startOrderPlacedConsumer,
	stopConsumer,
} from '../messaging/order-placed.consumer'
import {
	openDemoDb,
	ORDER_PLACED_DLQ,
	ORDER_PLACED_QUEUE,
	prepareBroker,
	publishRaw,
	queueDepth,
	waitUntil,
} from './demo-messaging-shared'

function deathReason(headers: Record<string, unknown> | undefined): string {
	const first = headers?.['x-first-death-reason']
	if (typeof first === 'string') {
		return first
	}
	const deaths = headers?.['x-death']
	if (Array.isArray(deaths) && deaths.length > 0) {
		const reason = (deaths[0] as { reason?: string })?.reason
		if (typeof reason === 'string') {
			return reason
		}
	}
	return ''
}

async function main(): Promise<void> {
	const { ds, store } = await openDemoDb()
	const { connection, channel } = await prepareBroker()
	await store.reset()

	const consumer = await startOrderPlacedConsumer(connection, channel, store)

	const poison = createOrderPlacedEvent({
		orderId: 'demo-poison',
		userId: 'demo-user',
		totalCents: 1,
		poison: true,
	})
	await publishRaw(poison, connection)

	await waitUntil(async () => {
		const dlq = await queueDepth(channel, ORDER_PLACED_DLQ)
		return dlq >= 1
	}, 'message in DLQ')

	await stopConsumer(consumer)

	const inspectConnection = await connectBroker()
	const inspectChannel = await createChannel(inspectConnection)
	const msg = await inspectChannel.get(ORDER_PLACED_DLQ, { noAck: false })
	if (!msg) {
		console.error('DLQ empty after wait')
		await inspectChannel.close()
		await inspectConnection.close()
		await ds.destroy()
		process.exit(1)
	}

	const reason = deathReason(
		msg.properties.headers as Record<string, unknown> | undefined,
	)
	inspectChannel.nack(msg, false, true)

	await waitUntil(async () => {
		const dlq = await queueDepth(inspectChannel, ORDER_PLACED_DLQ)
		return dlq >= 1
	}, 'message returned to DLQ')

	const work = await queueDepth(inspectChannel, ORDER_PLACED_QUEUE)
	const dlq = await queueDepth(inspectChannel, ORDER_PLACED_DLQ)
	const counts = await store.counts()

	console.log('rejected=1')
	console.log(`work=${work}`)
	console.log(`dlq=${dlq}`)
	console.log(`dlq-reason=${reason}`)
	console.log(`effect=${counts.effect}`)

	const allowed = new Set([
		'rejected',
		'expired',
		'maxlen',
		'delivery_limit',
	])
	const ok =
		work === 0 &&
		dlq === 1 &&
		counts.effect === 0 &&
		allowed.has(reason)

	await inspectChannel.close()
	await inspectConnection.close()
	await ds.destroy()

	if (!ok) {
		process.exit(1)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
