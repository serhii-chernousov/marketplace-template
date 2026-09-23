import {
	Column,
	Entity,
	OneToMany,
	PrimaryGeneratedColumn,
	Unique,
} from 'typeorm'
import { Product } from './product.entity'

/**
 * Product category. Deleting a category SET NULL on products.category_id.
 */
@Entity('categories')
@Unique('categories_slug_uniq', ['slug'])
export class Category {
	@PrimaryGeneratedColumn('identity', {
		type: 'bigint',
		generatedIdentity: 'ALWAYS',
	})
	id!: string

	@Column({ type: 'text' })
	slug!: string

	@Column({ type: 'text' })
	title!: string

	@OneToMany(() => Product, (product) => product.category)
	products!: Product[]
}
