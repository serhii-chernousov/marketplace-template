import { createOrderPlacedEvent } from '../messaging/order-placed.event'
import {
	startOrderPlacedConsumer,
	stopConsumer,
} from '../messaging/order-placed.consumer'
import { PREFETCH } from '../messaging/topology'
import {
	openDemoDb,
	ORDER_PLACED_DLQ,
	ORDER_PLACED_QUEUE,
	prepareBroker,
	publishRaw,
	queueDepth,
	waitUntil,
} from './demo-messaging-shared'

async function main(): Promise<void> {
	const { ds, store } = await openDemoDb()
	const { connection, channel } = await prepareBroker()
	await store.reset()

	const consumer = await startOrderPlacedConsumer(connection, channel, store)

	const events = Array.from({ length: 5 }, (_, index) =>
		createOrderPlacedEvent({
			orderId: `demo-order-${index + 1}`,
			userId: 'demo-user',
			totalCents: 1000 + index,
		}),
	)

	for (const event of events) {
		await publishRaw(event, connection)
	}

	await waitUntil(async () => {
		const counts = await store.counts()
		return counts.effect === 5 && counts.acked === 5
	}, 'effect=5 and acked=5')

	const work = await queueDepth(channel, ORDER_PLACED_QUEUE)
	const dlq = await queueDepth(channel, ORDER_PLACED_DLQ)
	const counts = await store.counts()

	console.log(`published=${events.length}`)
	console.log(`delivered=${counts.deliveries}`)
	console.log(`effect=${counts.effect}`)
	console.log(`acked=${counts.acked}`)
	console.log(`dlq=${dlq}`)
	console.log(`prefetch=${PREFETCH}`)

	const ok =
		events.length === 5 &&
		counts.deliveries === 5 &&
		counts.effect === 5 &&
		counts.acked === 5 &&
		dlq === 0 &&
		work === 0 &&
		PREFETCH >= 1 &&
		PREFETCH <= 2000

	await stopConsumer(consumer)
	await ds.destroy()

	if (!ok) {
		process.exit(1)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
