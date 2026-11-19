import { Injectable } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { Order as OrderRow } from '../entities/order.entity'
import { logger } from '../observability/logger'

const log = logger.child({ layer: 'orders.repo' })

@Injectable()
export class OrderRepository {
	constructor(private readonly dataSource: DataSource) {}

	async findWithItems(dbId: string): Promise<OrderRow | undefined> {
		const rows = await this.dataSource
			.getRepository(OrderRow)
			.createQueryBuilder('ord')
			.leftJoinAndSelect('ord.user', 'buyer')
			.leftJoinAndSelect('ord.items', 'item')
			.leftJoinAndSelect('item.product', 'product')
			.leftJoinAndSelect('product.seller', 'seller')
			.where('CAST(ord.id AS text) = :dbId', { dbId })
			.getMany()
		const row = rows[0]
		row?.items?.sort((left, right) =>
			left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
		)
		log.debug({ orderId: dbId, found: Boolean(row) }, 'order row loaded')
		return row
	}
}
