import { DataSource, QueryFailedError, type Repository } from 'typeorm'
import { Product } from '../../src/entities/product.entity'
import { User } from '../../src/entities/user.entity'
import { aProduct, aUser } from './testkit/builders'
import {
	startTestDatabase,
	stopTestDatabase,
	truncateAll,
} from './testkit/postgres'

function pgCode(err: unknown): string | undefined {
	if (err instanceof QueryFailedError) {
		const driverError = err.driverError as { code?: string }
		return driverError.code
	}
	return undefined
}

describe('Product repository', () => {
	let ds: DataSource
	let productRepo: Repository<Product>
	let userRepo: Repository<User>

	beforeAll(async () => {
		ds = await startTestDatabase()
		productRepo = ds.getRepository(Product)
		userRepo = ds.getRepository(User)
	})

	beforeEach(async () => {
		await truncateAll(ds)
	})

	afterAll(async () => {
		await stopTestDatabase()
	})

	it('persists a product and reads it back', async () => {
		const seller = await userRepo.save(
			aUser({ role: 'seller', email: 'seller-roundtrip@shop.test' }),
		)
		const saved = await productRepo.save(
			aProduct(seller, { name: 'Oak table' }),
		)
		const found = await productRepo.findOneByOrFail({ id: saved.id })
		expect(found.name).toBe('Oak table')
		expect(found.priceCents).toBe(4599)
	})

	it('rejects a duplicate product name with unique constraint 23505', async () => {
		const seller = await userRepo.save(
			aUser({ role: 'seller', email: 'seller-unique@shop.test' }),
		)
		await productRepo.save(aProduct(seller, { name: 'Vintage Lamp' }))
		let caught: unknown
		try {
			await productRepo.save(aProduct(seller, { name: 'Vintage Lamp' }))
		} catch (err: unknown) {
			caught = err
		}
		expect(caught).toBeDefined()
		expect(pgCode(caught)).toBe('23505')
	})

	it('rejects a product with a missing seller via foreign key 23503', async () => {
		let caught: unknown
		try {
			await ds.query(
				`INSERT INTO products (name, description, price_cents, stock, seller_id)
				 VALUES ('Ghost', '', 100, 1, 999999)`,
			)
		} catch (err: unknown) {
			caught = err
		}
		expect(caught).toBeDefined()
		expect(pgCode(caught)).toBe('23503')
	})
})
