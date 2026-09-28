import { DataSource } from 'typeorm'
import {
	CheckoutService,
	InsufficientFundsError,
	OutOfStockError,
} from '../checkout/checkout.service'
import base from '../database/data-source'
import { Product } from '../entities/product.entity'
import { User } from '../entities/user.entity'
import { asRows } from '../common/pg-rows'

const ATTEMPTS = 50
const START_STOCK = 10
const RACE_PRODUCT_NAME = 'Linen Shirt'

async function main(): Promise<void> {
	const ds = new DataSource({
		...base.options,
		extra: { max: 60 },
	})
	await ds.initialize()
	const checkout = new CheckoutService(ds)

	try {
		const productRepo = ds.getRepository(Product)
		const product = await productRepo.findOneByOrFail({
			name: RACE_PRODUCT_NAME,
		})
		await productRepo.update(
			{ id: product.id },
			{ stock: START_STOCK },
		)

		const buyers = await ds.getRepository(User).find({
			where: { role: 'buyer' },
			order: { id: 'ASC' },
		})
		if (buyers.length === 0) {
			throw new Error('No buyers in the database; run npm run seed first')
		}

		const minBalance = START_STOCK * product.priceCents
		const shortBuyer = buyers.find(
			(buyer) => buyer.balanceCents < minBalance,
		)
		if (shortBuyer) {
			throw new Error(
				`Buyer ${shortBuyer.email} balance_cents=${shortBuyer.balanceCents} ` +
					`< ${minBalance}; run npm run seed first`,
			)
		}

		const productId = product.id
		const attempts = await Promise.all(
			Array.from({ length: ATTEMPTS }, (_, index) => {
				const buyer = buyers[index % buyers.length]
				return checkout.checkoutOne(buyer.id, productId, 1).then(
					() => 'ok' as const,
					(err: unknown) => {
						if (
							err instanceof OutOfStockError ||
							err instanceof InsufficientFundsError
						) {
							return 'rejected' as const
						}
						throw err
					},
				)
			}),
		)

		const successes = attempts.filter((result) => result === 'ok').length
		const stockRows = asRows<{ stock: number }>(
			await ds.query(`SELECT stock FROM products WHERE id = $1`, [
				productId,
			]),
		)
		const finalStock = Number(stockRows[0].stock)
		const negativeRows = asRows<{ n: string }>(
			await ds.query(
				`SELECT count(*)::text AS n FROM products WHERE stock < 0`,
			),
		)
		const negativeCount = Number(negativeRows[0].n)

		console.log(`спроб: ${ATTEMPTS}`)
		console.log(`успішних: ${successes}`)
		console.log(`фінальний stock: ${finalStock}`)
		console.log(`рядків із відʼємним stock: ${negativeCount}`)

		if (
			ATTEMPTS < 50 ||
			successes !== START_STOCK ||
			finalStock !== 0 ||
			negativeCount !== 0
		) {
			process.exitCode = 1
		}
	} finally {
		await ds.destroy()
	}
}

main().catch((err: unknown) => {
	console.error(err)
	process.exitCode = 1
})
