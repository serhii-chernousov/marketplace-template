import path from 'node:path'
import { PactV3, MatchersV3 } from '@pact-foundation/pact'

const { like } = MatchersV3

describe('Marketplace frontend consumer contract', () => {
	const provider = new PactV3({
		consumer: 'marketplace-frontend',
		provider: 'marketplace-api',
		dir: path.resolve(process.cwd(), 'pacts'),
	})

	it('creates an order for listing-1', () => {
		provider
			.given('buyer can purchase listing-1')
			.uponReceiving('a request to create an order')
			.withRequest({
				method: 'POST',
				path: '/orders',
				headers: {
					'Content-Type': 'application/json',
					'X-User-Id': 'buyer-1',
					'X-User-Role': 'buyer',
					'Idempotency-Key': 'pact-create-order-1',
				},
				body: { items: [{ listing_id: 'listing-1', quantity: 1 }] },
			})
			.willRespondWith({
				status: 201,
				headers: {
					'Content-Type': 'application/json; charset=utf-8',
				},
				body: {
					id: like('order-1'),
					buyer_id: 'buyer-1',
					seller_id: 'seller-1',
					items: [
						{
							listing_id: 'listing-1',
							quantity: 1,
							price_cents: like(4599),
						},
					],
					total_cents: like(4599),
					status: 'paid',
				},
			})

		return provider.executeTest(async (mock) => {
			const res = await fetch(`${mock.url}/orders`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-User-Id': 'buyer-1',
					'X-User-Role': 'buyer',
					'Idempotency-Key': 'pact-create-order-1',
				},
				body: JSON.stringify({
					items: [{ listing_id: 'listing-1', quantity: 1 }],
				}),
			})
			if (res.status !== 201) {
				throw new Error(`mock consumer expected 201, got ${res.status}`)
			}
		})
	})
})
