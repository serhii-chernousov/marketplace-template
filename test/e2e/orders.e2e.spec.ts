import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DataSource } from 'typeorm'
import request from 'supertest'
import { QUEUE_REDIS } from '../../src/redis/redis.module'
import { bearerFor, emptyDenyListRedis } from '../integration/testkit/auth'
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
		})
			.overrideProvider(QUEUE_REDIS)
			.useValue(emptyDenyListRedis())
			.compile()
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
		const buyer = await bearerFor(app, 'buyer1@shop.local')
		const created = await request(app.getHttpServer())
			.post('/v1/orders')
			.set('Content-Type', 'application/json')
			.set('Authorization', buyer)
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
			.set('Authorization', buyer)
			.expect(200)
			.expect(created.body)
	})

	it('returns 404 for an unknown order', async () => {
		await request(app.getHttpServer())
			.get('/v1/orders/missing-order')
			.set('Authorization', await bearerFor(app, 'buyer1@shop.local'))
			.expect(404)
	})

	it('answers 401 without a token and 403 to the wrong role', async () => {
		const body = { items: [{ listing_id: 'listing-1', quantity: 1 }] }
		await request(app.getHttpServer())
			.post('/v1/orders')
			.set('Idempotency-Key', 'e2e-anon')
			.send(body)
			.expect(401)
		await request(app.getHttpServer())
			.post('/v1/orders')
			.set('Authorization', await bearerFor(app, 'seller1@shop.local'))
			.set('Idempotency-Key', 'e2e-seller')
			.send(body)
			.expect(403)
	})
})
