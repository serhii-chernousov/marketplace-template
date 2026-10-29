import { Request, Response } from 'express'
import type { AuthUser } from '../auth/auth-user'
import {
	parseLastEventId,
	OrderEventsController,
} from './order-events.controller'
import { OrderEventsService } from './order-events.service'
import { OrdersService } from './orders.service'
import { ProblemException } from '../types/problem.exception'

const BUYER: AuthUser = { id: '3', role: 'buyer', jti: 'j1', sid: 's1', exp: 0 }
const OTHER_BUYER: AuthUser = { ...BUYER, id: '4', jti: 'j2', sid: 's2' }

interface FakeResponse {
	chunks: string[]
	writeHead: jest.Mock
	write: jest.Mock
}

function createResponse(): FakeResponse {
	const res: FakeResponse = {
		chunks: [],
		writeHead: jest.fn(),
		write: jest.fn((chunk: string) => {
			res.chunks.push(String(chunk))
			return true
		}),
	}
	return res
}

function createController(
	assertCanRead: OrdersService['assertCanRead'],
	bus: OrderEventsService,
): OrderEventsController {
	return new OrderEventsController(
		{ assertCanRead } as unknown as OrdersService,
		bus,
	)
}

describe('parseLastEventId', () => {
	it('replays from the start when the header is absent', () => {
		expect(parseLastEventId(undefined)).toBe(0)
	})

	it('keeps a non-negative integer cursor', () => {
		expect(parseLastEventId('3')).toBe(3)
		expect(parseLastEventId('0')).toBe(0)
	})

	it('reads a non-integer header as from now', () => {
		expect(parseLastEventId('abc')).toBeNull()
		expect(parseLastEventId('')).toBeNull()
		expect(parseLastEventId('3.5')).toBeNull()
		expect(parseLastEventId('-1')).toBeNull()
	})
})

describe('OrderEventsController', () => {
	it('refuses the stream before writing when the caller cannot read', async () => {
		const assertCanRead = jest
			.fn()
			.mockRejectedValue(
				new ProblemException(
					403,
					'https://marketplace.local/problems/forbidden',
					'Forbidden',
					'You do not have access to this order',
					'/v1/orders/order-1',
				),
			)
		const bus = new OrderEventsService()
		bus.publish('order-1', 'paid')
		const controller = createController(assertCanRead, bus)
		const res = createResponse()

		await expect(
			controller.streamEvents(
				'order-1',
				undefined,
				OTHER_BUYER,
				{ on: jest.fn() } as unknown as Request,
				res as unknown as Response,
			),
		).rejects.toBeInstanceOf(ProblemException)

		expect(assertCanRead).toHaveBeenCalledWith('order-1', OTHER_BUYER)
		expect(res.writeHead).not.toHaveBeenCalled()
		expect(res.chunks).toEqual([])
	})

	it('skips buffered events when Last-Event-ID is not an integer', async () => {
		const assertCanRead = jest.fn().mockResolvedValue(undefined)
		const bus = new OrderEventsService()
		bus.publish('order-1', 'paid')
		const controller = createController(assertCanRead, bus)
		const res = createResponse()

		await controller.streamEvents(
			'order-1',
			'abc',
			BUYER,
			{ on: jest.fn() } as unknown as Request,
			res as unknown as Response,
		)
		bus.publish('order-1', 'shipped')

		const body = res.chunks.join('')
		expect(res.writeHead).toHaveBeenCalled()
		expect(body).toContain('retry: 1000')
		expect(body).not.toContain('id: 1\n')
		expect(body).toContain('id: 2\n')
		expect(body).toContain('"status":"shipped"')
	})

	it('replays events after a numeric Last-Event-ID', async () => {
		const assertCanRead = jest.fn().mockResolvedValue(undefined)
		const bus = new OrderEventsService()
		bus.publish('order-1', 'paid')
		bus.publish('order-1', 'shipped')
		bus.publish('order-1', 'delivered')
		const controller = createController(assertCanRead, bus)
		const res = createResponse()

		await controller.streamEvents(
			'1',
			'1',
			BUYER,
			{ on: jest.fn() } as unknown as Request,
			res as unknown as Response,
		)

		const body = res.chunks.join('')
		expect(assertCanRead).toHaveBeenCalledWith('order-1', BUYER)
		expect(body).not.toContain('id: 1\n')
		expect(body).toContain('id: 2\n')
		expect(body).toContain('id: 3\n')
	})
})
