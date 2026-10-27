import {
	startOrderPlacedConsumer,
	stopConsumer,
} from '../messaging/order-placed.consumer'
import { prepareBroker, waitUntil } from './demo-messaging-shared'
import { prepareOutboxDemo } from './outbox-demo-kit'

/**
 * Two API calls with one Idempotency-Key → one order, one outbox row,
 * one publish, one effect.
 */
async function main(): Promise<void> {
	const world = await prepareOutboxDemo()
	const { connection, channel } = await prepareBroker()
	const consumer = await startOrderPlacedConsumer(
		connection,
		channel,
		world.store,
	)
	let exitCode = 1
	try {
		const input = {
			userId: world.userId,
			items: [{ productId: world.productId, quantity: 1 }],
			idempotencyKey: 'hw22-demo-outbox',
		}
		await world.checkout.checkout(input)
		await world.checkout.checkout(input)
		await world.relay.publishPending({ userId: world.userId })
		await waitUntil(async () => {
			const counts = await world.counts()
			return (
				counts.published === 1 &&
				counts.deliveries === 1 &&
				counts.effect === 1 &&
				counts.processed === 1
			)
		}, 'outbox happy path')
		const counts = await world.counts()
		console.log('requests=2')
		console.log(`orders=${counts.orders}`)
		console.log(`outbox=${counts.outbox}`)
		console.log(`published=${counts.published}`)
		console.log(`deliveries=${counts.deliveries}`)
		console.log(`effect=${counts.effect}`)
		console.log(`processed=${counts.processed}`)
		const ok =
			counts.orders === 1 &&
			counts.outbox === 1 &&
			counts.published === 1 &&
			counts.deliveries === 1 &&
			counts.effect === 1 &&
			counts.processed === 1
		exitCode = ok ? 0 : 1
	} finally {
		await stopConsumer(consumer)
		await world.ds.destroy()
	}
	process.exit(exitCode)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
