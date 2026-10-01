import type { DeepPartial } from 'typeorm'
import type { User } from '../../../src/entities/user.entity'
import type { Product } from '../../../src/entities/product.entity'
import type { Order } from '../../../src/entities/order.entity'
import type { OrderItem } from '../../../src/entities/order-item.entity'

let seq = 0

/**
 * Valid unique defaults for a marketplace user. Override fields as needed.
 */
export function aUser(overrides: DeepPartial<User> = {}): DeepPartial<User> {
	seq += 1
	return {
		email: `user-${seq}-${Date.now()}@shop.test`,
		fullName: 'Test User',
		role: 'buyer',
		isActive: true,
		balanceCents: 1_000_000,
		...overrides,
	}
}

/**
 * Valid unique defaults for a product owned by the given seller.
 */
export function aProduct(
	seller: User,
	overrides: DeepPartial<Product> = {},
): DeepPartial<Product> {
	seq += 1
	return {
		seller,
		name: `Product ${seq}`,
		description: '',
		priceCents: 4599,
		stock: 10,
		isActive: true,
		...overrides,
	}
}

/**
 * Valid defaults for a paid order owned by the given buyer.
 */
export function anOrder(
	buyer: User,
	overrides: DeepPartial<Order> = {},
): DeepPartial<Order> {
	return {
		user: buyer,
		status: 'paid',
		totalCents: 4599,
		...overrides,
	}
}

/**
 * Valid defaults for an order line linking order ↔ product.
 */
export function anOrderItem(
	order: Order,
	product: Product,
	overrides: DeepPartial<OrderItem> = {},
): DeepPartial<OrderItem> {
	return {
		order,
		product,
		quantity: 1,
		unitPriceCents: product.priceCents,
		...overrides,
	}
}
