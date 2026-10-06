import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DataSource } from 'typeorm'
import request from 'supertest'
import { seedVintageLampCatalog } from '../integration/testkit/seed-catalog'
import {
	startTestDatabase,
	stopTestDatabase,
	truncateAll,
} from '../integration/testkit/postgres'

describe('Orders E2E', () => {
	let app: INestApplication
	let ds: DataSource

	beforeAll(async () => {
		ds = await startTestDatabase()
		const { AppModule } = await import('../../src/app.module')
		const { configureApp } = await import('../../src/configure-app')
		const moduleRef = await Test.createTestingModule({
			imports: [AppModule],
		}).compile()
		app = moduleRef.createNestApplication()
		configureApp(app)
		await app.init()
	})

	beforeEach(async () => {
		await truncateAll(ds)
		await seedVintageLampCatalog(ds)
	})

	afterAll(async () => {
		if (app) {
			await app.close()
		}
		await stopTestDatabase()
	})

	it('creates an order and reads it back', async () => {
		const key = `e2e-${Date.now()}`
		const created = await request(app.getHttpServer())
			.post('/v1/orders')
			.set('Content-Type', 'application/json')
			.set('X-User-Id', 'buyer-1')
			.set('X-User-Role', 'buyer')
			.set('Idempotency-Key', key)
			.send({ items: [{ listing_id: 'listing-1', quantity: 1 }] })
			.expect(201)

		expect(created.body.buyer_id).toBe('buyer-1')
		expect(created.body.seller_id).toBe('seller-1')
		expect(created.body.status).toBe('paid')
		expect(created.body.total_cents).toBe(4599)
		expect(created.body.items).toEqual([
			{ listing_id: 'listing-1', quantity: 1, price_cents: 4599 },
		])

		await request(app.getHttpServer())
			.get(`/v1/orders/${created.body.id}`)
			.set('X-User-Id', 'buyer-1')
			.set('X-User-Role', 'buyer')
			.expect(200)
			.expect(created.body)
	})

	it('returns 404 for an unknown order', async () => {
		await request(app.getHttpServer())
			.get('/v1/orders/missing-order')
			.set('X-User-Id', 'buyer-1')
			.set('X-User-Role', 'buyer')
			.expect(404)
	})
})
