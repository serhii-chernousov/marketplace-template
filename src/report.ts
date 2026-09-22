import dataSource from './data-source'
import { OrderItem } from './entities/order-item.entity'

interface RevenueRow {
	slug: string
	title: string
	revenue_cents: string
}

/**
 * Revenue by category for paid/shipped/delivered orders.
 * Cannot be expressed as Repository.find(): needs JOIN + SUM + GROUP BY.
 */
async function report(): Promise<void> {
	await dataSource.initialize()
	try {
		const rows = await dataSource
			.getRepository(OrderItem)
			.createQueryBuilder('item')
			.innerJoin('item.product', 'product')
			.innerJoin('product.category', 'category')
			.innerJoin('item.order', 'ord')
			.select('category.slug', 'slug')
			.addSelect('category.title', 'title')
			.addSelect('SUM(item.quantity * item.unitPriceCents)', 'revenue_cents')
			.where('ord.status IN (:...statuses)', {
				statuses: ['paid', 'shipped', 'delivered'],
			})
			.groupBy('category.slug')
			.addGroupBy('category.title')
			.orderBy('revenue_cents', 'DESC')
			.getRawMany<RevenueRow>()

		console.log('revenue by category (paid|shipped|delivered)')
		for (const row of rows) {
			const cents = Number(row.revenue_cents)
			const hryvnias = (cents / 100).toFixed(2)
			console.log(`${row.slug}\t${row.title}\t${cents} cents (${hryvnias} UAH)`)
		}
	} finally {
		await dataSource.destroy()
	}
}

report().catch((err: unknown) => {
	console.error(err)
	process.exitCode = 1
})
