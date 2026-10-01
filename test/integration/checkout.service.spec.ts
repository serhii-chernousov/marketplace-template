import { DataSource, type Repository } from 'typeorm'
import {
	CheckoutService,
	InsufficientFundsError,
	OutOfStockError,
} from '../../src/checkout/checkout.service'
import { Order } from '../../src/entities/order.entity'
import { Product } from '../../src/entities/product.entity'
import { User } from '../../src/entities/user.entity'
import { aProduct, aUser } from './testkit/builders'
import {
	startTestDatabase,
	stopTestDatabase,
	truncateAll,
} from './testkit/postgres'

describe('CheckoutService', () => {
	let ds: DataSource
	let checkout: CheckoutService
	let productRepo: Repository<Product>
	let userRepo: Repository<User>
	let orderRepo: Repository<Order>

	beforeAll(async () => {
		ds = await startTestDatabase()
		checkout = new CheckoutService(ds)
		productRepo = ds.getRepository(Product)
		userRepo = ds.getRepository(User)
		orderRepo = ds.getRepository(Order)
	})

	beforeEach(async () => {
		await truncateAll(ds)
	})

	afterAll(async () => {
		await stopTestDatabase()
	})

	async function seedBuyerAndProduct(opts?: {
		stock?: number
		balanceCents?: number
		priceCents?: number
	}): Promise<{ buyer: User; product: Product }> {
		const seller = await userRepo.save(aUser({ role: 'seller' }))
		const buyer = await userRepo.save(
			aUser({
				role: 'buyer',
				balanceCents: opts?.balanceCents ?? 1_000_000,
			}),
		)
		const product = await productRepo.save(
			aProduct(seller, {
				stock: opts?.stock ?? 10,
				priceCents: opts?.priceCents ?? 4599,
			}),
		)
		return { buyer, product }
	}

	it('decrements stock without going negative and writes a paid order', async () => {
		const { buyer, product } = await seedBuyerAndProduct({ stock: 5 })
		const result = await checkout.checkoutOne(buyer.id, product.id, 2)

		const updated = await productRepo.findOneByOrFail({ id: product.id })
		expect(updated.stock).toBe(3)
		expect(updated.stock).toBeGreaterThanOrEqual(0)

		const order = await orderRepo.findOneByOrFail({ id: result.orderId })
		expect(order.status).toBe('paid')
		expect(order.totalCents).toBe(9198)
		expect(result.totalCents).toBe(9198)
	})

	it('rolls back stock and balance when funds are insufficient', async () => {
		const { buyer, product } = await seedBuyerAndProduct({
			stock: 5,
			balanceCents: 100,
			priceCents: 4599,
		})

		await expect(
			checkout.checkoutOne(buyer.id, product.id, 1),
		).rejects.toBeInstanceOf(InsufficientFundsError)

		const stockAfter = await productRepo.findOneByOrFail({
			id: product.id,
		})
		const buyerAfter = await userRepo.findOneByOrFail({ id: buyer.id })
		expect(stockAfter.stock).toBe(5)
		expect(buyerAfter.balanceCents).toBe(100)
		expect(await orderRepo.count()).toBe(0)
	})

	it('rejects oversell so stock never goes negative', async () => {
		const { buyer, product } = await seedBuyerAndProduct({ stock: 1 })

		await expect(
			checkout.checkoutOne(buyer.id, product.id, 2),
		).rejects.toBeInstanceOf(OutOfStockError)

		const stockAfter = await productRepo.findOneByOrFail({
			id: product.id,
		})
		expect(stockAfter.stock).toBe(1)
		expect(await orderRepo.count()).toBe(0)
	})
})
