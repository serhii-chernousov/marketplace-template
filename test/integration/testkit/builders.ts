import type { DeepPartial } from 'typeorm'
import type { User } from '../../../src/entities/user.entity'
import type { Product } from '../../../src/entities/product.entity'
import type { Order } from '../../../src/entities/order.entity'
import type { OrderItem } from '../../../src/entities/order-item.entity'

let seq = 0

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
