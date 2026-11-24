import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers'
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

async function waitForStatus(
	app: INestApplication,
	orderId: string,
	bearer: string,
	expected: string,
): Promise<string> {
	const deadline = Date.now() + 20_000
	let status = ''
	while (Date.now() < deadline) {
		const res = await request(app.getHttpServer())
			.get(`/v1/orders/${orderId}`)
			.set('Authorization', bearer)
			.expect(200)
		status = res.body.status as string
		if (status === expected) {
			return status
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	return status
}

describe('Order contour E2E: checkout → outbox → RabbitMQ → paid', () => {
	let app: INestApplication
	let ds: DataSource
	let broker: StartedTestContainer

	beforeAll(async () => {
		broker = await new GenericContainer('rabbitmq:4.2-alpine')
			.withExposedPorts(5672)
			.withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
			.start()
		process.env.BROKER_URL = `amqp://guest:guest@${broker.getHost()}:${broker.getMappedPort(5672)}`
		process.env.MESSAGING_ENABLED = '1'
		process.env.OUTBOX_POLL_MS = '100'

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
		await broker?.stop()
	})

	it('creates a pending order that the consumer moves to paid exactly once', async () => {
		const buyer = await bearerFor(app, 'buyer1@shop.local')
		const body = { items: [{ listing_id: 'listing-1', quantity: 1 }] }
		const created = await request(app.getHttpServer())
			.post('/v1/orders')
			.set('Authorization', buyer)
			.set('Idempotency-Key', 'contour-1')
			.send(body)
			.expect(201)
		expect(created.body.status).toBe('pending')

		await expect(
			waitForStatus(app, created.body.id as string, buyer, 'paid'),
		).resolves.toBe('paid')

		const replay = await request(app.getHttpServer())
			.post('/v1/orders')
			.set('Authorization', buyer)
			.set('Idempotency-Key', 'contour-1')
			.send(body)
			.expect(201)
		expect(replay.headers['idempotency-replay']).toBe('true')
		expect(replay.body.id).toBe(created.body.id)

		const [counts] = (await ds.query(`
			SELECT
				(SELECT count(*)::int FROM orders) AS orders,
				(SELECT count(*)::int FROM outbox WHERE published_at IS NOT NULL) AS published,
				(SELECT count(*)::int FROM order_placed_effects) AS effects
		`)) as Array<{ orders: number; published: number; effects: number }>
		expect(counts).toEqual({ orders: 1, published: 1, effects: 1 })
	})

	it('lets the seller ship and deliver, and rejects skipping a step', async () => {
		const buyer = await bearerFor(app, 'buyer1@shop.local')
		const seller = await bearerFor(app, 'seller1@shop.local')
		const created = await request(app.getHttpServer())
			.post('/v1/orders')
			.set('Authorization', buyer)
			.set('Idempotency-Key', 'contour-2')
			.send({ items: [{ listing_id: 'listing-1', quantity: 1 }] })
			.expect(201)
		const orderId = created.body.id as string
		await waitForStatus(app, orderId, buyer, 'paid')

		const patch = (status: string, bearer: string) =>
			request(app.getHttpServer())
				.patch(`/v1/orders/${orderId}/status`)
				.set('Authorization', bearer)
				.send({ status })

		await patch('delivered', seller).expect(409)
		await patch('shipped', buyer).expect(403)
		await patch('shipped', seller).expect(200)
		await patch('delivered', seller).expect(200)

		const final = await request(app.getHttpServer())
			.get(`/v1/orders/${orderId}`)
			.set('Authorization', buyer)
			.expect(200)
		expect(final.body.status).toBe('delivered')
	})
})
