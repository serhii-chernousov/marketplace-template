import { DataSource } from 'typeorm'
import base from './data-source'
import { Order } from './entities/order.entity'
import { OrderItem } from './entities/order-item.entity'
import { Product } from './entities/product.entity'
import { QueryCountLogger } from './logging/query-count-logger'

interface SampleResult {
	take: number
	naive: number
	join: number
	queryStrategy: number
}

/**
 * Loads order → items → product with a query-per-row loop (classic N+1).
 */
async function loadNaive(ds: DataSource, take: number): Promise<number> {
	const orderRepo = ds.getRepository(Order)
	const itemRepo = ds.getRepository(OrderItem)
	const productRepo = ds.getRepository(Product)
	const orders = await orderRepo.find({
		take,
		order: { id: 'ASC' },
	})
	for (const order of orders) {
		const items = await itemRepo.find({
			where: { order: { id: order.id } },
			loadRelationIds: { relations: ['product'] },
		})
		for (const item of items) {
			const productId = item.product as unknown as string
			await productRepo.findOneByOrFail({ id: productId })
		}
	}
	return orders.length
}

/**
 * Same graph in one JOIN (leftJoinAndSelect). LIMIT sits in a subquery so
 * TypeORM does not split take+relations into two queries.
 */
async function loadJoin(ds: DataSource, take: number): Promise<void> {
	const orderRepo = ds.getRepository(Order)
	const idsQb = orderRepo
		.createQueryBuilder('o')
		.select('o.id')
		.orderBy('o.id', 'ASC')
		.limit(take)

	await orderRepo
		.createQueryBuilder('ord')
		.leftJoinAndSelect('ord.items', 'items')
		.leftJoinAndSelect('items.product', 'product')
		.where(`ord.id IN (${idsQb.getQuery()})`)
		.setParameters(idsQb.getParameters())
		.orderBy('ord.id', 'ASC')
		.getMany()
}

/**
 * Same graph with relationLoadStrategy: 'query' — 1 + 2 × levels, independent of N.
 */
async function loadQueryStrategy(ds: DataSource, take: number): Promise<void> {
	await ds.getRepository(Order).find({
		take,
		order: { id: 'ASC' },
		relations: { items: { product: true } },
		relationLoadStrategy: 'query',
	})
}

async function measure(
	ds: DataSource,
	logger: QueryCountLogger,
	take: number,
): Promise<SampleResult> {
	logger.reset()
	await loadNaive(ds, take)
	const naive = logger.count

	logger.reset()
	await loadJoin(ds, take)
	const join = logger.count

	logger.reset()
	await loadQueryStrategy(ds, take)
	const queryStrategy = logger.count

	return { take, naive, join, queryStrategy }
}

async function main(): Promise<void> {
	const logger = new QueryCountLogger()
	const ds = new DataSource({
		...base.options,
		logger,
		logging: ['query'],
	})
	await ds.initialize()
	try {
		const takes = [3, 6]
		const rows: SampleResult[] = []
		for (const take of takes) {
			rows.push(await measure(ds, logger, take))
		}

		console.log('')
		console.log('graph: order → items → product')
		console.log('strategy                         N=3   N=6')
		const naive3 = rows[0].naive
		const naive6 = rows[1].naive
		const join3 = rows[0].join
		const join6 = rows[1].join
		const q3 = rows[0].queryStrategy
		const q6 = rows[1].queryStrategy
		console.log(`naive (query in loop)            ${naive3}    ${naive6}`)
		console.log(`relations / leftJoinAndSelect    ${join3}     ${join6}`)
		console.log(`relationLoadStrategy: query      ${q3}     ${q6}`)
		console.log('')
		console.log(`before=${naive6} after=${join6}`)
	} finally {
		await ds.destroy()
	}
}

main().catch((err: unknown) => {
	console.error(err)
	process.exitCode = 1
})
