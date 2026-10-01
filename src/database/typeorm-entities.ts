import { Category } from '../entities/category.entity'
import { Job } from '../entities/job.entity'
import { OrderItem } from '../entities/order-item.entity'
import { Order } from '../entities/order.entity'
import { Product } from '../entities/product.entity'
import { User } from '../entities/user.entity'

/** Shared TypeORM entity list for Nest DatabaseModule and test DataSources. */
export const TYPEORM_ENTITIES = [
	User,
	Category,
	Product,
	Order,
	OrderItem,
	Job,
]
