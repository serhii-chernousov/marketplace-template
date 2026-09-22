import {
	Check,
	Column,
	Entity,
	JoinColumn,
	ManyToOne,
	OneToMany,
	PrimaryGeneratedColumn,
} from 'typeorm'
import { Category } from './category.entity'
import { OrderItem } from './order-item.entity'
import { User } from './user.entity'

/**
 * Listing owned by a seller.
 * Price is integer kopecks (`price_cents`), never float.
 * Expression index `idx_products_lower_name` on lower(name) is added in the migration.
 */
@Entity('products')
@Check('products_name_chk', 'length(btrim(name)) > 0')
@Check('products_price_chk', 'price_cents > 0')
@Check('products_stock_chk', 'stock >= 0')
export class Product {
	@PrimaryGeneratedColumn('identity', {
		type: 'bigint',
		generatedIdentity: 'ALWAYS',
	})
	id!: string

	@ManyToOne(() => User, (user) => user.products, {
		onDelete: 'RESTRICT',
		nullable: false,
	})
	@JoinColumn({
		name: 'seller_id',
		foreignKeyConstraintName: 'products_seller_fk',
	})
	seller!: User

	@ManyToOne(() => Category, (category) => category.products, {
		onDelete: 'SET NULL',
		nullable: true,
	})
	@JoinColumn({
		name: 'category_id',
		foreignKeyConstraintName: 'products_category_fk',
	})
	category!: Category | null

	@Column({ type: 'text' })
	name!: string

	@Column({ type: 'text', default: '' })
	description!: string

	@Column({ name: 'price_cents', type: 'int' })
	priceCents!: number

	@Column({ type: 'int', default: 0 })
	stock!: number

	@Column({ name: 'is_active', type: 'boolean', default: true })
	isActive!: boolean

	@Column({
		name: 'created_at',
		type: 'timestamptz',
		default: () => 'now()',
	})
	createdAt!: Date

	@OneToMany(() => OrderItem, (item) => item.product)
	orderItems!: OrderItem[]
}
