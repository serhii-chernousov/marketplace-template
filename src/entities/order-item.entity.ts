import {
	Check,
	Column,
	Entity,
	JoinColumn,
	ManyToOne,
	PrimaryGeneratedColumn,
	Unique,
} from 'typeorm'
import { Order } from './order.entity'
import { Product } from './product.entity'

/**
 * Join-entity for orders ↔ products (M:N with payload).
 * `quantity` and `unit_price_cents` (price snapshot) live on the link —
 * not `@ManyToMany`, otherwise a later product price change rewrites history.
 */
@Entity('order_items')
@Unique('order_items_uniq', ['order', 'product'])
@Check('order_items_qty_chk', 'quantity > 0')
@Check('order_items_price_chk', 'unit_price_cents > 0')
export class OrderItem {
	@PrimaryGeneratedColumn('identity', {
		type: 'bigint',
		generatedIdentity: 'ALWAYS',
	})
	id!: string

	@ManyToOne(() => Order, (order) => order.items, {
		onDelete: 'CASCADE',
		nullable: false,
	})
	@JoinColumn({
		name: 'order_id',
		foreignKeyConstraintName: 'order_items_order_fk',
	})
	order!: Order

	@ManyToOne(() => Product, (product) => product.orderItems, {
		onDelete: 'RESTRICT',
		nullable: false,
	})
	@JoinColumn({
		name: 'product_id',
		foreignKeyConstraintName: 'order_items_product_fk',
	})
	product!: Product

	@Column({ type: 'int' })
	quantity!: number

	@Column({ name: 'unit_price_cents', type: 'int' })
	unitPriceCents!: number
}
