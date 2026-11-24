#!/usr/bin/env node
/**
 * Main contour over plain HTTP against a running API:
 * login → POST /v1/orders (pending) → outbox → RabbitMQ consumer → paid
 * → same Idempotency-Key replays the same order → seller ships and delivers.
 */
import {
	createOrder,
	getOrder,
	login,
	patchStatus,
	waitForStatus,
} from './lib/api-client.mjs'

const buyer = await login('buyer1@shop.local')
const seller = await login('seller1@shop.local')
const key = `contour-${Date.now()}`

const created = await createOrder(buyer, key)
if (created.status !== 201) {
	console.error(`POST /v1/orders → ${created.status}`, created.body)
	process.exit(1)
}
const orderId = created.body.id
console.log(`order=${orderId}`)
console.log(`created=${created.body.status}`)

const paid = await waitForStatus(buyer, orderId, 'paid')
console.log(`after-consumer=${paid}`)

const replay = await createOrder(buyer, key)
const replaySame = replay.status === 201 && replay.body.id === orderId ? 1 : 0
console.log(`replay-same-order=${replaySame}`)

const skip = await patchStatus(seller, orderId, 'delivered')
console.log(`skip-to-delivered=${skip.status}`)
const shipped = await patchStatus(seller, orderId, 'shipped')
const delivered = await patchStatus(seller, orderId, 'delivered')
console.log(`ship=${shipped.status} deliver=${delivered.status}`)

const final = (await getOrder(buyer, orderId)).body.status
console.log(`final=${final}`)

const ok =
	created.body.status === 'pending' &&
	paid === 'paid' &&
	replaySame === 1 &&
	skip.status === 409 &&
	shipped.status === 200 &&
	delivered.status === 200 &&
	final === 'delivered'
process.exit(ok ? 0 : 1)
