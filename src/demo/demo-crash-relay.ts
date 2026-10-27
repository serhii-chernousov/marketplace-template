import {
	startOrderPlacedConsumer,
	stopConsumer,
} from '../messaging/order-placed.consumer'
import { RelayCrashedError } from '../messaging/outbox-relay'
import { prepareBroker, waitUntil } from './demo-messaging-shared'
import { prepareOutboxDemo } from './outbox-demo-kit'

/**
 * Simulated crash between publish and UPDATE published_at (ROLLBACK).
 * The same event is published again; the consumer applies it once.
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
		await world.checkout.checkout({
			userId: world.userId,
			items: [{ productId: world.productId, quantity: 1 }],
		})

		try {
			await world.relay.publishPending({
				userId: world.userId,
				crashAfterPublish: true,
			})
			throw new Error('expected relay to crash after publish')
		} catch (err: unknown) {
			if (!(err instanceof RelayCrashedError)) {
				throw err
			}
		}

		await world.relay.publishPending({ userId: world.userId })
		await waitUntil(async () => {
			const counts = await world.counts()
			return (
				counts.deliveries >= 2 &&
				counts.applied === 1 &&
				counts.effect === 1 &&
				counts.processed === 1
			)
		}, 'duplicate delivery collapsed to one effect')

		const counts = await world.counts()
		console.log(`published=${counts.published}`)
		console.log(`deliveries=${counts.deliveries}`)
		console.log(`applied=${counts.applied}`)
		console.log(`effect=${counts.effect}`)
		console.log(`processed=${counts.processed}`)

		const ok =
			counts.published === 1 &&
			counts.deliveries >= 2 &&
			counts.applied === 1 &&
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
