#!/usr/bin/env node
/**
 * Realtime isolation over socket.io, against a running API.
 *
 * Default: A (buyer1) joins its own order; B (buyer2) is refused that room and
 * joins its own order instead → only A hears the status change.
 * --same-room: B is a second socket of buyer1 in the same room → B must hear
 * it, which proves the script measures reality.
 */
import { io } from 'socket.io-client'
import {
	BASE,
	createOrder,
	login,
	patchStatus,
	waitForStatus,
} from './lib/api-client.mjs'

const sameRoom = process.argv.includes('--same-room')

function connect(token) {
	const socket = io(BASE, { auth: { token }, transports: ['websocket'] })
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('connect timeout')), 5000)
		socket.once('connect', () => {
			clearTimeout(timer)
			resolve(socket)
		})
		socket.once('connect_error', (err) => {
			clearTimeout(timer)
			reject(err)
		})
	})
}

function join(socket, orderId) {
	return new Promise((resolve) => {
		socket.emit('join', orderId, (ack) => resolve(ack ?? { ok: false }))
	})
}

function received(socket, orderId, status, timeoutMs) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			socket.off('order.status', onEvent)
			resolve(0)
		}, timeoutMs)
		function onEvent(event) {
			if (event.id === orderId && event.status === status) {
				clearTimeout(timer)
				socket.off('order.status', onEvent)
				resolve(1)
			}
		}
		socket.on('order.status', onEvent)
	})
}

async function paidOrder(token, key) {
	const res = await createOrder(token, key)
	if (res.status !== 201) {
		throw new Error(
			`POST /v1/orders → ${res.status} ${JSON.stringify(res.body)}`,
		)
	}
	await waitForStatus(token, res.body.id, 'paid')
	return res.body.id
}

const stamp = Date.now()
const buyer1 = await login('buyer1@shop.local')
const buyer2 = await login('buyer2@shop.local')
const seller = await login('seller1@shop.local')

const orderA = await paidOrder(buyer1, `rt-a-${stamp}`)
const orderB = await paidOrder(buyer2, `rt-b-${stamp}`)

const clientA = await connect(buyer1)
const clientB = await connect(sameRoom ? buyer1 : buyer2)

try {
	await join(clientA, orderA)
	if (sameRoom) {
		await join(clientB, orderA)
	} else {
		const foreign = await join(clientB, orderA)
		console.log(`B_JOIN_FOREIGN=${foreign.ok ? 'allowed' : 'denied'}`)
		await join(clientB, orderB)
	}

	const waitA = received(clientA, orderA, 'shipped', 3000)
	const waitB = received(clientB, orderA, 'shipped', 3000)
	const patched = await patchStatus(seller, orderA, 'shipped')
	if (patched.status !== 200) {
		throw new Error(
			`PATCH status → ${patched.status} ${JSON.stringify(patched.body)}`,
		)
	}

	const gotA = await waitA
	const gotB = await waitB
	console.log(`A_RECEIVED=${gotA}`)
	console.log(`B_RECEIVED=${gotB}`)
	process.exitCode = gotA === 1 && gotB === (sameRoom ? 1 : 0) ? 0 : 1
} finally {
	clientA.close()
	clientB.close()
}
