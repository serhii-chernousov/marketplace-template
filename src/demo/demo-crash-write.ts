import { OutboxWriteAbortedError } from '../checkout/checkout.service'
import {
	ORDER_PLACED_QUEUE,
	prepareBroker,
	queueDepth,
} from './demo-messaging-shared'
import { prepareOutboxDemo } from './outbox-demo-kit'

/**
 * The business transaction throws after the outbox INSERT and before COMMIT.
 * The order and the event disappear together, so the relay has nothing to send.
 */
async function main(): Promise<void> {
	const world = await prepareOutboxDemo()
	const { connection, channel } = await prepareBroker()
	let exitCode = 1
	try {
		let writeFailed = 0
		try {
			await world.checkout.checkout({
				userId: world.userId,
				items: [{ productId: world.productId, quantity: 1 }],
				failAfterOutbox: true,
			})
		} catch (err: unknown) {
			if (!(err instanceof OutboxWriteAbortedError)) {
				throw err
			}
			writeFailed = 1
		}

		const before = await queueDepth(channel, ORDER_PLACED_QUEUE)
		await world.relay.publishPending({ userId: world.userId })
		const after = await queueDepth(channel, ORDER_PLACED_QUEUE)
		const counts = await world.counts()

		console.log(`write-failed=${writeFailed}`)
		console.log(`orders=${counts.orders}`)
		console.log(`outbox=${counts.outbox}`)
		console.log(`published=${counts.published}`)
		console.log(`deliveries=${counts.deliveries}`)
		console.log(`effect=${counts.effect}`)

		const ok =
			writeFailed === 1 &&
			counts.orders === 0 &&
			counts.outbox === 0 &&
			counts.published === 0 &&
			counts.deliveries === 0 &&
			counts.effect === 0 &&
			before === 0 &&
			after === 0
		exitCode = ok ? 0 : 1
	} finally {
		await channel.close()
		await connection.close()
		await world.ds.destroy()
	}
	process.exit(exitCode)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
