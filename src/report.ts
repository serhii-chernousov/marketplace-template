import dataSource from './database/data-source'
import { OrderItem } from './entities/order-item.entity'

interface RevenueRow {
	slug: string
	title: string
	revenue_cents: string
}

/**
 * Revenue by category for paid/shipped/delivered orders.
 * leftJoin keeps products after category SET NULL; NULL category_id
 * falls into the uncategorized bucket.
 */
async function report(): Promise<void> {
	await dataSource.initialize()
	try {
		const rows = await dataSource
			.getRepository(OrderItem)
			.createQueryBuilder('item')
			.innerJoin('item.product', 'product')
			.leftJoin('product.category', 'category')
			.innerJoin('item.order', 'ord')
			.select("COALESCE(category.slug, 'uncategorized')", 'slug')
			.addSelect("COALESCE(category.title, 'Uncategorized')", 'title')
			.addSelect('SUM(item.quantity * item.unitPriceCents)', 'revenue_cents')
			.where('ord.status IN (:...statuses)', {
				statuses: ['paid', 'shipped', 'delivered'],
			})
			.groupBy("COALESCE(category.slug, 'uncategorized')")
			.addGroupBy("COALESCE(category.title, 'Uncategorized')")
			.orderBy('revenue_cents', 'DESC')
			.getRawMany<RevenueRow>()

		console.log('revenue by category (paid|shipped|delivered)')
		console.log(
			'uncategorized = products.category_id IS NULL (ON DELETE SET NULL)',
		)
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
