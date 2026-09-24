import { DataSource } from 'typeorm'
import base from '../database/data-source'
import { Order } from '../entities/order.entity'
import { OrderItem } from '../entities/order-item.entity'
import { Product } from '../entities/product.entity'
import { QueryCountLogger } from '../logging/query-count-logger'

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

function parseTakes(argv: string[]): number[] | null {
	const raw = argv.slice(2).filter((arg) => arg.length > 0)
	if (raw.length === 0) {
		return null
	}
	const takes = raw.map((arg) => {
		const value = Number(arg)
		if (!Number.isInteger(value) || value < 1) {
			throw new Error(
				`Invalid take "${arg}". Usage: node dist/demo/demo-nplus1.js <n1> <n2> [...]`,
			)
		}
		return value
	})
	return [...new Set(takes)].sort((a, b) => a - b)
}

async function resolveTakes(ds: DataSource): Promise<number[]> {
	const fromArgv = parseTakes(process.argv)
	if (fromArgv) {
		return fromArgv
	}
	const total = await ds.getRepository(Order).count()
	if (total < 1) {
		throw new Error('No orders in the database; run npm run seed first')
	}
	const small = Math.min(3, total)
	return small === total ? [total] : [small, total]
}

function printTable(rows: SampleResult[]): void {
	const ns = rows.map((row) => row.take)
	const col = (value: string | number) => String(value).padStart(8)
	console.log('')
	console.log('graph: order → items → product')
	console.log(
		`strategy                         ${ns.map((n) => col(`N=${n}`)).join('')}`,
	)
	const line = (label: string, pick: (row: SampleResult) => number): string =>
		`${label.padEnd(33)}${rows.map((row) => col(pick(row))).join('')}`
	console.log(line('naive (query in loop)', (row) => row.naive))
	console.log(line('relations / leftJoinAndSelect', (row) => row.join))
	console.log(line('relationLoadStrategy: query', (row) => row.queryStrategy))
	const last = rows[rows.length - 1]
	console.log('')
	console.log(`before=${last.naive} after=${last.join}`)
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
		const takes = await resolveTakes(ds)
		const rows: SampleResult[] = []
		for (const take of takes) {
			rows.push(await measure(ds, logger, take))
		}
		printTable(rows)
	} finally {
		await ds.destroy()
	}
}

main().catch((err: unknown) => {
	console.error(err)
	process.exitCode = 1
})
