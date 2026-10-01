import { DataSource, type Repository } from 'typeorm'
import { Order } from '../../src/entities/order.entity'
import { OrderItem } from '../../src/entities/order-item.entity'
import { Product } from '../../src/entities/product.entity'
import { User } from '../../src/entities/user.entity'
import { anOrder, anOrderItem, aProduct, aUser } from './testkit/builders'
import {
	startTestDatabase,
	stopTestDatabase,
	truncateAll,
} from './testkit/postgres'

describe('Order repository', () => {
	let ds: DataSource
	let orderRepo: Repository<Order>
	let itemRepo: Repository<OrderItem>
	let productRepo: Repository<Product>
	let userRepo: Repository<User>

	beforeAll(async () => {
		ds = await startTestDatabase()
		orderRepo = ds.getRepository(Order)
		itemRepo = ds.getRepository(OrderItem)
		productRepo = ds.getRepository(Product)
		userRepo = ds.getRepository(User)
	})

	beforeEach(async () => {
		await truncateAll(ds)
	})

	afterAll(async () => {
		await stopTestDatabase()
	})

	it('persists an order with a line item', async () => {
		const buyer = await userRepo.save(aUser({ role: 'buyer' }))
		const seller = await userRepo.save(aUser({ role: 'seller' }))
		const product = await productRepo.save(aProduct(seller))
		const order = await orderRepo.save(
			anOrder(buyer, { totalCents: 9198 }),
		)
		await itemRepo.save(
			anOrderItem(order, product, {
				quantity: 2,
				unitPriceCents: 4599,
			}),
		)
		const found = await orderRepo.findOneOrFail({
			where: { id: order.id },
			relations: { items: true },
		})
		expect(found.items).toHaveLength(1)
		expect(found.totalCents).toBe(9198)
	})

	it('computes order total via JOIN and SUM', async () => {
		const buyer = await userRepo.save(aUser({ role: 'buyer' }))
		const seller = await userRepo.save(aUser({ role: 'seller' }))
		const product = await productRepo.save(aProduct(seller))
		const order = await orderRepo.save(
			anOrder(buyer, { totalCents: 9198 }),
		)
		await itemRepo.save(
			anOrderItem(order, product, {
				quantity: 2,
				unitPriceCents: 4599,
			}),
		)
		const rows: Array<{ computed_total: number }> = await ds.query(
			`
			SELECT o.id,
			       COALESCE(SUM(oi.quantity * oi.unit_price_cents), 0)::int AS computed_total
			FROM orders o
			JOIN order_items oi ON oi.order_id = o.id
			WHERE o.id = $1
			GROUP BY o.id
			`,
			[order.id],
		)
		expect(Number(rows[0].computed_total)).toBe(9198)
	})

	it('keeps a single user row with ON CONFLICT DO NOTHING', async () => {
		const buyer = await userRepo.save(
			aUser({ email: 'same@shop.test' }),
		)
		await ds.query(
			`
			INSERT INTO users (email, full_name, role, balance_cents)
			VALUES ($1, 'Again', 'buyer', 0)
			ON CONFLICT (email) DO NOTHING
			`,
			[buyer.email],
		)
		expect(await userRepo.count({ where: { email: buyer.email } })).toBe(1)
	})
})
