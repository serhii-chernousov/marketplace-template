import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib'
import { EffectStore } from './effect-store'
import {
	isTransientConsumerError,
	startOrderPlacedConsumer,
} from './order-placed.consumer'

const EVENT = {
	eventId: '11111111-1111-4111-8111-111111111111',
	type: 'order.placed',
	occurredAt: '2026-01-01T00:00:00.000Z',
	orderId: 'order-1',
	userId: 'buyer-1',
	totalCents: 100,
}

function message(body: unknown): ConsumeMessage {
	const raw = typeof body === 'string' ? body : JSON.stringify(body)
	return { content: Buffer.from(raw) } as ConsumeMessage
}

describe('isTransientConsumerError', () => {
	it('treats connection loss and serialization failures as transient', () => {
		expect(isTransientConsumerError({ code: 'ECONNRESET' })).toBe(true)
		expect(isTransientConsumerError({ code: '08006' })).toBe(true)
		expect(isTransientConsumerError({ code: '40001' })).toBe(true)
		expect(isTransientConsumerError({ driverError: { code: '57P01' } })).toBe(
			true,
		)
		expect(
			isTransientConsumerError(new Error('Connection terminated unexpectedly')),
		).toBe(true)
	})

	it('treats bad payloads and data errors as permanent', () => {
		expect(isTransientConsumerError(new SyntaxError('Unexpected token'))).toBe(
			false,
		)
		expect(
			isTransientConsumerError(new Error('Invalid order.placed payload')),
		).toBe(false)
		expect(isTransientConsumerError({ code: '22P02' })).toBe(false)
		expect(isTransientConsumerError({ driverError: { code: '23503' } })).toBe(
			false,
		)
	})
})

describe('startOrderPlacedConsumer', () => {
	let onMessage: (msg: ConsumeMessage | null) => Promise<void>
	let channel: Channel
	let reject: jest.Mock
	let nack: jest.Mock
	let ack: jest.Mock
	let store: EffectStore

	beforeEach(() => {
		jest.spyOn(console, 'error').mockImplementation(() => undefined)
		reject = jest.fn()
		nack = jest.fn()
		ack = jest.fn()
		onMessage = async () => undefined
		channel = {
			consume: jest.fn(
				async (
					_queue: string,
					handler: (msg: ConsumeMessage | null) => Promise<void>,
				) => {
					onMessage = handler
					return { consumerTag: 'ctag' }
				},
			),
			reject,
			nack,
			ack,
		} as unknown as Channel
		store = {
			recordDelivery: jest.fn().mockResolvedValue(undefined),
			applyEffect: jest.fn().mockResolvedValue(true),
			markAcked: jest.fn().mockResolvedValue(undefined),
		} as unknown as EffectStore
	})

	afterEach(() => {
		jest.restoreAllMocks()
	})

	it('counts a poison reject and does not requeue it', async () => {
		const handle = await startOrderPlacedConsumer(
			{} as ChannelModel,
			channel,
			store,
		)

		await onMessage(message({ ...EVENT, poison: true }))

		expect(reject).toHaveBeenCalledWith(expect.anything(), false)
		expect(nack).not.toHaveBeenCalled()
		expect(handle.rejected).toBe(1)
	})

	it('requeues a valid event when the database connection drops', async () => {
		;(store.recordDelivery as jest.Mock).mockRejectedValue({
			code: 'ECONNRESET',
		})
		const handle = await startOrderPlacedConsumer(
			{} as ChannelModel,
			channel,
			store,
		)

		await onMessage(message(EVENT))

		expect(nack).toHaveBeenCalledWith(expect.anything(), false, true)
		expect(reject).not.toHaveBeenCalled()
		expect(handle.rejected).toBe(0)
	})

	it('rejects an invalid payload into the DLQ', async () => {
		const handle = await startOrderPlacedConsumer(
			{} as ChannelModel,
			channel,
			store,
		)

		await onMessage(message('not-json'))

		expect(reject).toHaveBeenCalledWith(expect.anything(), false)
		expect(nack).not.toHaveBeenCalled()
		expect(handle.rejected).toBe(1)
	})
})
