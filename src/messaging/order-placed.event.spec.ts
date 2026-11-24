import {
	createOrderPlacedEvent,
	orderPlacedEventId,
} from './order-placed.event'

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('orderPlacedEventId', () => {
	it('gives the same order the same event id', () => {
		expect(orderPlacedEventId('order-42')).toBe(orderPlacedEventId('order-42'))
		expect(orderPlacedEventId('order-42')).not.toBe(
			orderPlacedEventId('order-43'),
		)
	})

	it('is a valid uuid, so the uuid columns accept it', () => {
		expect(orderPlacedEventId('order-42')).toMatch(UUID)
	})

	it('is the default id of a new order.placed event', () => {
		const event = createOrderPlacedEvent({
			orderId: 'order-42',
			userId: '3',
			totalCents: 100,
		})
		expect(event.eventId).toBe(orderPlacedEventId('order-42'))
	})
})
