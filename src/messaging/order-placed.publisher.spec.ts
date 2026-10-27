import type { ConfirmChannel } from 'amqplib'
import { connectBroker, createConfirmChannel } from './broker'
import { OrderPlacedEvent } from './order-placed.event'
import {
	publishOrderPlaced,
	withOrderPlacedChannel,
} from './order-placed.publisher'

jest.mock('./broker', () => ({
	requireBrokerUrl: jest.fn(() => 'amqp://guest:guest@localhost:5672'),
	connectBroker: jest.fn(),
	createConfirmChannel: jest.fn(),
}))

const EVENT: OrderPlacedEvent = {
	eventId: '11111111-1111-4111-8111-111111111111',
	type: 'order.placed',
	occurredAt: '2026-01-01T00:00:00.000Z',
	orderId: '9',
	userId: '3',
	totalCents: 1000,
}

const OTHER: OrderPlacedEvent = {
	...EVENT,
	eventId: '22222222-2222-4222-8222-222222222222',
	orderId: '10',
}

describe('order.placed publisher', () => {
	let channel: {
		publish: jest.Mock
		waitForConfirms: jest.Mock
		close: jest.Mock
	}
	let connection: { close: jest.Mock }

	beforeEach(() => {
		channel = {
			publish: jest.fn(),
			waitForConfirms: jest.fn().mockResolvedValue(undefined),
			close: jest.fn().mockResolvedValue(undefined),
		}
		connection = { close: jest.fn().mockResolvedValue(undefined) }
		jest.mocked(connectBroker).mockResolvedValue(connection as never)
		jest
			.mocked(createConfirmChannel)
			.mockResolvedValue(channel as unknown as ConfirmChannel)
	})

	it('publishes on the channel it was given and does not connect', async () => {
		await publishOrderPlaced(EVENT, channel as unknown as ConfirmChannel)

		expect(connectBroker).not.toHaveBeenCalled()
		expect(channel.publish).toHaveBeenCalledTimes(1)
		expect(channel.waitForConfirms).toHaveBeenCalledTimes(1)
	})

	it('opens one connection and one channel for every publish in the cycle', async () => {
		await withOrderPlacedChannel(async (confirmChannel) => {
			await publishOrderPlaced(EVENT, confirmChannel)
			await publishOrderPlaced(OTHER, confirmChannel)
		})

		expect(connectBroker).toHaveBeenCalledTimes(1)
		expect(createConfirmChannel).toHaveBeenCalledTimes(1)
		expect(channel.publish).toHaveBeenCalledTimes(2)
		expect(channel.close).toHaveBeenCalledTimes(1)
		expect(connection.close).toHaveBeenCalledTimes(1)
	})

	it('closes the connection when the channel cannot be opened', async () => {
		jest.mocked(createConfirmChannel).mockRejectedValue(new Error('no channel'))

		await expect(withOrderPlacedChannel(async () => undefined)).rejects.toThrow(
			'no channel',
		)
		expect(connection.close).toHaveBeenCalledTimes(1)
	})
})
