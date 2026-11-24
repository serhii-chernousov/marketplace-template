import { DataSource, type Repository } from 'typeorm'
import { Order } from '../../src/entities/order.entity'
import { OrderItem } from '../../src/entities/order-item.entity'
import { Product } from '../../src/entities/product.entity'
import { User } from '../../src/entities/user.entity'
import { OrderRepository } from '../../src/orders/order.repository'
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

	async function seedPaidOrderWithItem(): Promise<{
		order: Order
		product: Product
	}> {
		const buyer = await userRepo.save(aUser({ role: 'buyer' }))
		const seller = await userRepo.save(aUser({ role: 'seller' }))
		const product = await productRepo.save(aProduct(seller))
		const order = await orderRepo.save(anOrder(buyer, { totalCents: 9198 }))
		await itemRepo.save(
			anOrderItem(order, product, {
				quantity: 2,
				unitPriceCents: 4599,
			}),
		)
		return { order, product }
	}

	it('persists an order with a line item', async () => {
		const { order } = await seedPaidOrderWithItem()
		const found = await orderRepo.findOneOrFail({
			where: { id: order.id },
			relations: { items: true },
		})
		expect(found.items).toHaveLength(1)
		expect(found.totalCents).toBe(9198)
	})

	it('computes order total via JOIN and SUM', async () => {
		const { order } = await seedPaidOrderWithItem()
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
		const buyer = await userRepo.save(aUser({ email: 'same@shop.test' }))
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

	it('pages orders newest first with a keyset cursor', async () => {
		const buyer = await userRepo.save(aUser({ role: 'buyer' }))
		const seller = await userRepo.save(aUser({ role: 'seller' }))
		const product = await productRepo.save(aProduct(seller))
		const ids: string[] = []
		for (let i = 0; i < 3; i += 1) {
			const order = await orderRepo.save(anOrder(buyer))
			await itemRepo.save(anOrderItem(order, product))
			ids.push(order.id)
		}
		const repo = new OrderRepository(ds)

		const first = await repo.findPage({ buyerId: buyer.id, limit: 2 })
		expect(first.rows.map((row) => row.id)).toEqual([ids[2], ids[1]])
		expect(first.hasMore).toBe(true)

		const second = await repo.findPage({
			sellerId: seller.id,
			limit: 2,
			beforeId: ids[1],
		})
		expect(second.rows.map((row) => row.id)).toEqual([ids[0]])
		expect(second.hasMore).toBe(false)
	})

	it('cancels only from an allowed status and returns stock and money', async () => {
		const { order, product } = await seedPaidOrderWithItem()
		const buyerBefore = await userRepo.findOneOrFail({
			where: { orders: { id: order.id } },
		})
		const repo = new OrderRepository(ds)

		await expect(
			repo.transitionStatus(order.id, 'delivered', ['shipped']),
		).resolves.toBe(false)
		await expect(
			repo.transitionStatus(order.id, 'cancelled', ['pending', 'paid']),
		).resolves.toBe(true)

		const stock = await productRepo.findOneByOrFail({ id: product.id })
		expect(stock.stock).toBe(product.stock + 2)
		const buyerAfter = await userRepo.findOneByOrFail({ id: buyerBefore.id })
		expect(buyerAfter.balanceCents).toBe(buyerBefore.balanceCents + 9198)

		await expect(
			repo.transitionStatus(order.id, 'cancelled', ['pending', 'paid']),
		).resolves.toBe(false)
	})
})
