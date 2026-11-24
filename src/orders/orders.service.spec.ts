import type { AuthUser } from '../auth/auth-user'
import { Order as OrderRow } from '../entities/order.entity'
import { ProblemException } from '../types/problem.exception'
import { OrderEventsService } from './order-events.service'
import { OrderRepository } from './order.repository'
import { OrdersService } from './orders.service'

const SELLER: AuthUser = {
	id: '20',
	role: 'seller',
	jti: 'j',
	sid: 's',
	exp: 0,
}

function orderRow(status: OrderRow['status']): OrderRow {
	return {
		id: '7',
		status,
		totalCents: 1000,
		user: { id: '10', email: 'buyer@example.com' },
		items: [
			{
				id: '1',
				quantity: 1,
				unitPriceCents: 1000,
				product: {
					name: 'Lamp',
					seller: { id: '20', email: 'seller@example.com' },
				},
			},
		],
	} as unknown as OrderRow
}

function createService(
	status: OrderRow['status'],
	transitioned: boolean,
): {
	service: OrdersService
	transitionStatus: jest.Mock
	bus: OrderEventsService
} {
	const transitionStatus = jest.fn().mockResolvedValue(transitioned)
	const repo = {
		findWithItems: jest.fn().mockResolvedValue(orderRow(status)),
		transitionStatus,
	} as unknown as OrderRepository
	const bus = new OrderEventsService()
	const service = new OrdersService(
		{ listings: new Map() } as never,
		{} as never,
		{} as never,
		bus,
		{} as never,
		repo,
		{} as never,
	)
	return { service, transitionStatus, bus }
}

async function problemStatus(run: Promise<unknown>): Promise<number> {
	try {
		await run
	} catch (err) {
		if (err instanceof ProblemException) {
			return err.status
		}
		throw err
	}
	return 0
}

describe('OrdersService.updateStatus', () => {
	it('ships a paid order and tells realtime subscribers', async () => {
		const { service, transitionStatus, bus } = createService('paid', true)

		await expect(
			service.updateStatus('order-7', SELLER, 'shipped'),
		).resolves.toEqual({ id: 'order-7', status: 'shipped' })

		expect(transitionStatus).toHaveBeenCalledWith('7', 'shipped', ['paid'])
		expect(bus.replayAfter('order-7', 0).map((e) => e.status)).toEqual([
			'shipped',
		])
	})

	it('refuses to mark an order paid by hand', async () => {
		const { service, transitionStatus } = createService('pending', true)

		expect(
			await problemStatus(service.updateStatus('order-7', SELLER, 'paid')),
		).toBe(400)
		expect(transitionStatus).not.toHaveBeenCalled()
	})

	it('answers 409 when the current status does not allow the move', async () => {
		const { service, bus } = createService('pending', false)

		expect(
			await problemStatus(service.updateStatus('order-7', SELLER, 'delivered')),
		).toBe(409)
		expect(bus.replayAfter('order-7', 0)).toEqual([])
	})

	it('answers 403 to a seller who does not own the order', async () => {
		const { service, transitionStatus } = createService('paid', true)
		const stranger: AuthUser = { ...SELLER, id: '99' }

		expect(
			await problemStatus(service.updateStatus('order-7', stranger, 'shipped')),
		).toBe(403)
		expect(transitionStatus).not.toHaveBeenCalled()
	})
})
