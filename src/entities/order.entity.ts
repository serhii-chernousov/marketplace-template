import {
	Check,
	Column,
	Entity,
	Index,
	JoinColumn,
	ManyToOne,
	OneToMany,
	PrimaryGeneratedColumn,
} from 'typeorm'
import { OrderItem } from './order-item.entity'
import { User } from './user.entity'

export type OrderStatus =
	| 'pending'
	| 'paid'
	| 'shipped'
	| 'delivered'
	| 'cancelled'

/**
 * Buyer order. `total_cents` is denormalized sum of items (integer kopecks).
 */
@Entity('orders')
@Index('idx_orders_user_created', ['user', 'createdAt'])
@Index('idx_orders_cancelled_created', ['createdAt'], {
	where: "status = 'cancelled'",
})
@Check(
	'orders_status_chk',
	`status IN ('pending','paid','shipped','delivered','cancelled')`,
)
@Check('orders_total_chk', 'total_cents >= 0')
export class Order {
	@PrimaryGeneratedColumn('identity', {
		type: 'bigint',
		generatedIdentity: 'ALWAYS',
	})
	id!: string

	@ManyToOne(() => User, (user) => user.orders, {
		onDelete: 'RESTRICT',
		nullable: false,
	})
	@JoinColumn({
		name: 'user_id',
		foreignKeyConstraintName: 'orders_user_fk',
	})
	user!: User

	@Column({ type: 'text', default: 'pending' })
	status!: OrderStatus

	@Column({ name: 'total_cents', type: 'int', default: 0 })
	totalCents!: number

	@Column({
		name: 'created_at',
		type: 'timestamptz',
		default: () => 'now()',
	})
	createdAt!: Date

	@OneToMany(() => OrderItem, (item) => item.order)
	items!: OrderItem[]
}
