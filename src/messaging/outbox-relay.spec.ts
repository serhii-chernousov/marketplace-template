import { DataSource } from 'typeorm'
import { OrderPlacedEvent } from './order-placed.event'
import { OutboxRelay, RelayCrashedError } from './outbox-relay'
import {
	publishOrderPlaced,
	withOrderPlacedChannel,
} from './order-placed.publisher'

jest.mock('./order-placed.publisher', () => ({
	publishOrderPlaced: jest.fn(),
	withOrderPlacedChannel: jest.fn(),
}))

const EVENT: OrderPlacedEvent = {
	eventId: '11111111-1111-4111-8111-111111111111',
	type: 'order.placed',
	occurredAt: '2026-01-01T00:00:00.000Z',
	orderId: '9',
	userId: '3',
	totalCents: 1000,
}

function row(
	id: string,
	orderId = id,
): { id: string; payload: OrderPlacedEvent } {
	return {
		id,
		payload: {
			...EVENT,
			eventId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
			orderId,
		},
	}
}

function dataSource(rows: { id: string; payload: OrderPlacedEvent }[]): {
	ds: DataSource
	manager: { query: jest.Mock }
	poolQuery: jest.Mock
} {
	const manager = {
		query: jest.fn(async (sql: string) => {
			if (sql.includes('SELECT')) {
				return rows
			}
			return []
		}),
	}
	const poolQuery = jest.fn().mockResolvedValue([])
	const ds = {
		transaction: jest.fn(async (run: (m: typeof manager) => Promise<number>) =>
			run(manager),
		),
		query: poolQuery,
	}
	return { ds: ds as unknown as DataSource, manager, poolQuery }
}

describe('OutboxRelay', () => {
	let channel: object

	beforeEach(() => {
		channel = {}
		jest.mocked(publishOrderPlaced).mockReset()
		jest.mocked(withOrderPlacedChannel).mockReset()
		jest
			.mocked(withOrderPlacedChannel)
			.mockImplementation(async (run) => run(channel as never))
	})

	it('reuses one channel for every row in the cycle', async () => {
		jest.mocked(publishOrderPlaced).mockResolvedValue(undefined)
		const { ds, manager, poolQuery } = dataSource([row('1'), row('2')])

		await expect(new OutboxRelay(ds).publishPending()).resolves.toBe(2)

		expect(withOrderPlacedChannel).toHaveBeenCalledTimes(1)
		expect(publishOrderPlaced).toHaveBeenCalledTimes(2)
		expect(jest.mocked(publishOrderPlaced).mock.calls[0][1]).toBe(channel)
		expect(jest.mocked(publishOrderPlaced).mock.calls[1][1]).toBe(channel)
		const updates = manager.query.mock.calls.filter((call) =>
			String(call[0]).includes('SET published_at'),
		)
		expect(updates).toHaveLength(2)
		expect(String(updates[0][0])).toContain('attempts = attempts + 1')
		expect(poolQuery).not.toHaveBeenCalled()
	})

	it('does not open a channel when nothing is pending', async () => {
		const { ds } = dataSource([])

		await expect(new OutboxRelay(ds).publishPending()).resolves.toBe(0)

		expect(withOrderPlacedChannel).not.toHaveBeenCalled()
		expect(publishOrderPlaced).not.toHaveBeenCalled()
	})

	it('commits attempts after a failed publish rolls the claim back', async () => {
		jest.mocked(publishOrderPlaced).mockRejectedValue(new Error('broker down'))
		const { ds, manager, poolQuery } = dataSource([row('7')])

		await expect(new OutboxRelay(ds).publishPending()).rejects.toThrow(
			'broker down',
		)

		expect(poolQuery).toHaveBeenCalledTimes(1)
		const [sql, params] = poolQuery.mock.calls[0]
		expect(sql).toContain('attempts = attempts + 1')
		expect(sql).not.toContain('published_at')
		expect(params).toEqual(['7'])
		expect(
			manager.query.mock.calls.some((call) =>
				String(call[0]).includes('SET published_at'),
			),
		).toBe(false)
	})

	it('does not record an attempt when the crash is after a successful publish', async () => {
		jest.mocked(publishOrderPlaced).mockResolvedValue(undefined)
		const { ds, poolQuery } = dataSource([row('1')])

		await expect(
			new OutboxRelay(ds).publishPending({ crashAfterPublish: true }),
		).rejects.toBeInstanceOf(RelayCrashedError)

		expect(poolQuery).not.toHaveBeenCalled()
	})
})
