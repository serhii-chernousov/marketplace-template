import { spawn } from 'child_process'
import path from 'path'
import {
	connectBroker,
	createChannel,
} from '../messaging/broker'
import { createOrderPlacedEvent } from '../messaging/order-placed.event'
import {
	startOrderPlacedConsumer,
	stopConsumer,
} from '../messaging/order-placed.consumer'
import { assertTopology, resetQueues } from '../messaging/topology'
import {
	openDemoDb,
	publishRaw,
	waitUntil,
} from './demo-messaging-shared'

/**
 * Child entry: consume one message, apply effect, SIGKILL before ack.
 * Invoked as: node dist/demo/demo-duplicate.js --crash-worker
 */
async function crashWorker(): Promise<void> {
	process.env.CRASH_BEFORE_ACK = '1'
	const { ds, store } = await openDemoDb()
	const connection = await connectBroker()
	const channel = await createChannel(connection)
	await assertTopology(channel)
	await startOrderPlacedConsumer(connection, channel, store)
	// Stay alive until SIGKILL from consumer handler.
	await new Promise(() => undefined)
	await ds.destroy()
}

async function main(): Promise<void> {
	if (process.argv.includes('--crash-worker')) {
		await crashWorker()
		return
	}

	const { ds, store } = await openDemoDb()
	const connection = await connectBroker()
	const channel = await createChannel(connection)
	await resetQueues(channel)
	await assertTopology(channel)
	await store.reset()

	const event = createOrderPlacedEvent({
		orderId: 'demo-dup-order',
		userId: 'demo-user',
		totalCents: 4200,
	})
	await publishRaw(event, connection)

	const workerScript = path.join(__dirname, 'demo-duplicate.js')
	const child = spawn(process.execPath, [workerScript, '--crash-worker'], {
		env: {
			...process.env,
			CRASH_BEFORE_ACK: '1',
		},
		stdio: ['ignore', 'inherit', 'inherit'],
	})

	await new Promise<void>((resolve, reject) => {
		child.on('exit', (code, signal) => {
			if (signal === 'SIGKILL' || code !== 0) {
				resolve()
				return
			}
			reject(new Error(`crash-worker exited unexpectedly code=${code}`))
		})
		child.on('error', reject)
	})

	await waitUntil(async () => {
		const counts = await store.counts()
		return counts.effect === 1
	}, 'first effect applied before crash')

	const retryConnection = await connectBroker()
	const retryChannel = await createChannel(retryConnection)
	await assertTopology(retryChannel)
	const consumer = await startOrderPlacedConsumer(
		retryConnection,
		retryChannel,
		store,
	)

	await waitUntil(async () => {
		const counts = await store.counts()
		return counts.deliveries >= 2 && counts.acked === 1
	}, 'second delivery acked')

	const counts = await store.counts()

	console.log(`deliveries=${counts.deliveries}`)
	console.log(`effect=${counts.effect}`)
	console.log(`skipped=${counts.skipped}`)

	const ok = counts.deliveries >= 2 && counts.effect === 1

	await stopConsumer(consumer)
	await channel.close()
	await connection.close()
	await ds.destroy()

	if (!ok) {
		process.exit(1)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
