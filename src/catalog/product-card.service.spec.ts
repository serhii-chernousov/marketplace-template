import type Redis from 'ioredis'
import {
	ProductCardRepository,
	type ProductCard,
} from './product-card.repository'
import { ProductCardService } from './product-card.service'

const CARD: ProductCard = {
	id: '1',
	name: 'Lamp',
	stock: 3,
	priceCents: 100,
	rating: 1,
	orderLines: 2,
}

/** SELECT slower than the old 2s poll budget and still inside the 5s lock. */
const SLOW_SELECT_MS = 2500

function memoryRedis(): Redis {
	const strings = new Map<string, string>()
	return {
		get: jest.fn(async (key: string) => strings.get(key) ?? null),
		set: jest.fn(
			async (key: string, value: string, ...args: Array<string | number>) => {
				if (args.includes('NX') && strings.has(key)) {
					return null
				}
				strings.set(key, value)
				return 'OK'
			},
		),
		eval: jest.fn(
			async (_script: string, _keys: number, key: string, token: string) => {
				if (strings.get(key) === token) {
					strings.delete(key)
					return 1
				}
				return 0
			},
		),
	} as unknown as Redis
}

function slowRepository(): ProductCardRepository {
	return {
		load: jest.fn(
			() =>
				new Promise<ProductCard>((resolve) => {
					setTimeout(() => resolve(CARD), SLOW_SELECT_MS)
				}),
		),
	} as unknown as ProductCardRepository
}

describe('ProductCardService single-flight', () => {
	afterEach(() => {
		jest.useRealTimers()
	})

	it('gives waiters the card when SELECT outlives 2s but finishes inside the lock', async () => {
		jest.useFakeTimers()
		const repository = slowRepository()
		const service = new ProductCardService(memoryRedis(), repository)
		const leader = service.getCard(CARD.id)
		const waiter = service.getCard(CARD.id)
		const pending = Promise.all([leader, waiter])

		await jest.advanceTimersByTimeAsync(SLOW_SELECT_MS + 100)

		await expect(pending).resolves.toEqual([CARD, CARD])
		expect(repository.load).toHaveBeenCalledTimes(1)
	})
})
