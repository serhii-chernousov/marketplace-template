import { OrderEventsService } from './order-events.service'

describe('OrderEventsService', () => {
	let bus: OrderEventsService

	beforeEach(() => {
		bus = new OrderEventsService()
	})

	it('assigns monotonic ids and replays only events after lastEventId', () => {
		bus.publish('order-1', 'paid')
		bus.publish('order-1', 'shipped')
		bus.publish('order-1', 'delivered')
		bus.publish('order-1', 'cancelled')

		const replayed = bus.replayAfter('order-1', 3)

		expect(replayed.map((e) => e.id)).toEqual([4])
		expect(replayed[0].status).toBe('cancelled')
	})

	it('does not replay events from another order', () => {
		bus.publish('order-1', 'paid')
		bus.publish('order-2', 'shipped')
		bus.publish('order-1', 'delivered')

		const replayed = bus.replayAfter('order-1', 0)

		expect(replayed.map((e) => e.orderId)).toEqual(['order-1', 'order-1'])
		expect(replayed.map((e) => e.status)).toEqual(['paid', 'delivered'])
	})

	it('never reuses an event id', () => {
		const a = bus.publish('order-1', 'paid')
		const b = bus.publish('order-1', 'shipped')
		expect(b.id).toBeGreaterThan(a.id)
	})
})
