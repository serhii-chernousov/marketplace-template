import {
	Check,
	Column,
	Entity,
	OneToMany,
	PrimaryGeneratedColumn,
	Unique,
} from 'typeorm'
import { Order } from './order.entity'
import { Product } from './product.entity'

export type UserRole = 'buyer' | 'seller' | 'admin'

/**
 * Marketplace account: buyer, seller or admin.
 * Sellers own products; buyers own orders — same table, different FKs.
 */
@Entity('users')
@Unique('users_email_uniq', ['email'])
@Check('users_email_chk', `position('@' in email) > 1`)
@Check('users_role_chk', `role IN ('buyer', 'seller', 'admin')`)
@Check('users_balance_chk', 'balance_cents >= 0')
export class User {
	@PrimaryGeneratedColumn('identity', {
		type: 'bigint',
		generatedIdentity: 'ALWAYS',
	})
	id!: string

	@Column({ type: 'text' })
	email!: string

	@Column({ name: 'full_name', type: 'text' })
	fullName!: string

	@Column({ type: 'text', default: 'buyer' })
	role!: UserRole

	@Column({ name: 'is_active', type: 'boolean', default: true })
	isActive!: boolean

	@Column({ name: 'balance_cents', type: 'int', default: 0 })
	balanceCents!: number

	@Column({
		name: 'created_at',
		type: 'timestamptz',
		default: () => 'now()',
	})
	createdAt!: Date

	@OneToMany(() => Product, (product) => product.seller)
	products!: Product[]

	@OneToMany(() => Order, (order) => order.user)
	orders!: Order[]
}
