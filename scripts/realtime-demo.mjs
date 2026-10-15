#!/usr/bin/env node
/**
 * Headless room-isolation demo for WebSocket order.status events.
 *
 * Default: clients join different rooms → B must NOT hear A's status change.
 * --same-room: both clients join order A → B MUST hear (proves the script measures reality).
 */
import { io } from 'socket.io-client'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const sameRoom = process.argv.includes('--same-room')

async function createOrder(listingId, key) {
	const res = await fetch(`${BASE}/v1/orders`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-User-Id': 'buyer-1',
			'X-User-Role': 'buyer',
			'Idempotency-Key': key,
		},
		body: JSON.stringify({
			items: [{ listing_id: listingId, quantity: 1 }],
		}),
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`POST /v1/orders failed: ${res.status} ${text}`)
	}
	const body = await res.json()
	return body.id
}

async function patchStatus(orderId, status) {
	const res = await fetch(`${BASE}/orders/${orderId}/status`, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
			'X-User-Id': 'buyer-1',
			'X-User-Role': 'buyer',
		},
		body: JSON.stringify({ status }),
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`PATCH status failed: ${res.status} ${text}`)
	}
}

function connectClient() {
	return io(BASE, {
		auth: { userId: 'buyer-1', role: 'buyer' },
		transports: ['websocket', 'polling'],
	})
}

function waitConnect(socket) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('connect timeout')), 5000)
		socket.once('connect', () => {
			clearTimeout(t)
			resolve()
		})
		socket.once('connect_error', (err) => {
			clearTimeout(t)
			reject(err)
		})
	})
}

function joinRoom(socket, orderId) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`join timeout for ${orderId}`)), 5000)
		socket.emit('join', orderId, (ack) => {
			clearTimeout(t)
			if (ack?.ok) {
				resolve(ack)
			} else {
				reject(new Error(`join denied: ${ack?.error ?? 'unknown'}`))
			}
		})
	})
}

function waitEvent(socket, timeoutMs) {
	return new Promise((resolve) => {
		const t = setTimeout(() => {
			socket.off('order.status', onEvent)
			resolve(false)
		}, timeoutMs)
		function onEvent() {
			clearTimeout(t)
			socket.off('order.status', onEvent)
			resolve(true)
		}
		socket.on('order.status', onEvent)
	})
}

async function main() {
	const stamp = Date.now()
	const orderA = await createOrder('listing-1', `rt-a-${stamp}`)
	const orderB = await createOrder('listing-2', `rt-b-${stamp}`)
	const roomB = sameRoom ? orderA : orderB
	const expectB = sameRoom ? 1 : 0

	const clientA = connectClient()
	const clientB = connectClient()

	try {
		await Promise.all([waitConnect(clientA), waitConnect(clientB)])
		await Promise.all([joinRoom(clientA, orderA), joinRoom(clientB, roomB)])

		const waitA = waitEvent(clientA, 3000)
		const waitB = waitEvent(clientB, 3000)

		await patchStatus(orderA, 'shipped')

		const gotA = (await waitA) ? 1 : 0
		const gotB = (await waitB) ? 1 : 0

		console.log(`A_RECEIVED=${gotA}`)
		console.log(`B_RECEIVED=${gotB}`)

		const ok = gotA === 1 && gotB === expectB
		process.exit(ok ? 0 : 1)
	} finally {
		clientA.close()
		clientB.close()
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
