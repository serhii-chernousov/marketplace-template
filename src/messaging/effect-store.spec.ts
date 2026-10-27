import { DataSource } from 'typeorm'
import { EffectStore } from './effect-store'
import { OrderPlacedEvent } from './order-placed.event'

const EVENT: OrderPlacedEvent = {
	eventId: '11111111-1111-4111-8111-111111111111',
	type: 'order.placed',
	occurredAt: '2026-01-01T00:00:00.000Z',
	orderId: '9',
	userId: '3',
	totalCents: 1000,
}

describe('EffectStore.applyEffect', () => {
	it('counts only calls that return true', async () => {
		let inserted = true
		const manager = {
			query: jest.fn(async (sql: string) => {
				if (sql.includes('order_placed_effects')) {
					return inserted ? [{ event_id: EVENT.eventId }] : []
				}
				return []
			}),
		}
		const query = jest.fn().mockResolvedValue(undefined)
		const dataSource = {
			transaction: jest.fn(
				async (run: (m: typeof manager) => Promise<boolean>) => run(manager),
			),
			query,
		}
		const store = new EffectStore(dataSource as unknown as DataSource)

		await expect(store.applyEffect(EVENT)).resolves.toBe(true)
		inserted = false
		await expect(store.applyEffect(EVENT)).resolves.toBe(false)

		expect(store.appliedCount()).toBe(1)

		await store.reset()
		expect(store.appliedCount()).toBe(0)
	})
})
