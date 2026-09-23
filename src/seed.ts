import dataSource from './data-source'
import { Category } from './entities/category.entity'
import { Order, OrderStatus } from './entities/order.entity'
import { OrderItem } from './entities/order-item.entity'
import { Product } from './entities/product.entity'
import { User, UserRole } from './entities/user.entity'

interface UserSeed {
	email: string
	fullName: string
	role: UserRole
}

interface CategorySeed {
	slug: string
	title: string
}

interface ProductSeed {
	name: string
	description: string
	priceCents: number
	stock: number
	sellerEmail: string
	categorySlug: string
}

interface OrderSeed {
	buyerEmail: string
	status: OrderStatus
	createdAt: Date
	items: { productName: string; quantity: number }[]
}

const USERS: UserSeed[] = [
	{ email: 'seller1@shop.local', fullName: 'Seller One', role: 'seller' },
	{ email: 'seller2@shop.local', fullName: 'Seller Two', role: 'seller' },
	{ email: 'buyer1@shop.local', fullName: 'Buyer One', role: 'buyer' },
	{ email: 'buyer2@shop.local', fullName: 'Buyer Two', role: 'buyer' },
	{ email: 'buyer3@shop.local', fullName: 'Buyer Three', role: 'buyer' },
	{ email: 'buyer4@shop.local', fullName: 'Buyer Four', role: 'buyer' },
	{ email: 'buyer5@shop.local', fullName: 'Buyer Five', role: 'buyer' },
	{ email: 'admin@shop.local', fullName: 'Shop Admin', role: 'admin' },
]

const CATEGORIES: CategorySeed[] = [
	{ slug: 'books', title: 'Books' },
	{ slug: 'electronics', title: 'Electronics' },
	{ slug: 'home', title: 'Home' },
	{ slug: 'toys', title: 'Toys' },
	{ slug: 'sports', title: 'Sports' },
	{ slug: 'fashion', title: 'Fashion' },
]

const PRODUCTS: ProductSeed[] = [
	{
		name: 'Vintage Lamp',
		description: 'Brass desk lamp',
		priceCents: 4599,
		stock: 12,
		sellerEmail: 'seller1@shop.local',
		categorySlug: 'home',
	},
	{
		name: 'Ceramic Mug',
		description: 'Matte ceramic mug',
		priceCents: 899,
		stock: 40,
		sellerEmail: 'seller1@shop.local',
		categorySlug: 'home',
	},
	{
		name: 'Wooden Chair',
		description: 'Oak dining chair',
		priceCents: 12900,
		stock: 8,
		sellerEmail: 'seller1@shop.local',
		categorySlug: 'home',
	},
	{
		name: 'USB-C Hub',
		description: '7-in-1 hub',
		priceCents: 2599,
		stock: 25,
		sellerEmail: 'seller2@shop.local',
		categorySlug: 'electronics',
	},
	{
		name: 'Paperback Novel',
		description: 'Contemporary fiction',
		priceCents: 1499,
		stock: 30,
		sellerEmail: 'seller2@shop.local',
		categorySlug: 'books',
	},
	{
		name: 'Football',
		description: 'Size 5 match ball',
		priceCents: 3299,
		stock: 15,
		sellerEmail: 'seller2@shop.local',
		categorySlug: 'sports',
	},
	{
		name: 'Building Blocks',
		description: 'Wooden blocks set',
		priceCents: 2199,
		stock: 18,
		sellerEmail: 'seller1@shop.local',
		categorySlug: 'toys',
	},
	{
		name: 'Linen Shirt',
		description: 'Unisex linen shirt',
		priceCents: 5499,
		stock: 10,
		sellerEmail: 'seller2@shop.local',
		categorySlug: 'fashion',
	},
]

const ORDERS: OrderSeed[] = [
	{
		buyerEmail: 'buyer1@shop.local',
		status: 'paid',
		createdAt: new Date('2025-03-15T10:00:00.000Z'),
		items: [
			{ productName: 'Vintage Lamp', quantity: 1 },
			{ productName: 'Ceramic Mug', quantity: 2 },
		],
	},
	{
		buyerEmail: 'buyer2@shop.local',
		status: 'shipped',
		createdAt: new Date('2025-04-02T12:00:00.000Z'),
		items: [{ productName: 'USB-C Hub', quantity: 1 }],
	},
	{
		buyerEmail: 'buyer3@shop.local',
		status: 'delivered',
		createdAt: new Date('2025-04-20T09:30:00.000Z'),
		items: [
			{ productName: 'Paperback Novel', quantity: 3 },
			{ productName: 'Linen Shirt', quantity: 1 },
		],
	},
	{
		buyerEmail: 'buyer4@shop.local',
		status: 'pending',
		createdAt: new Date('2025-05-01T08:00:00.000Z'),
		items: [{ productName: 'Wooden Chair', quantity: 2 }],
	},
	{
		buyerEmail: 'buyer5@shop.local',
		status: 'cancelled',
		createdAt: new Date('2025-01-10T18:00:00.000Z'),
		items: [{ productName: 'Football', quantity: 1 }],
	},
	{
		buyerEmail: 'buyer1@shop.local',
		status: 'paid',
		createdAt: new Date('2025-06-11T14:15:00.000Z'),
		items: [{ productName: 'Building Blocks', quantity: 1 }],
	},
]

/**
 * Deterministic, idempotent seed: unique keys are email, slug, products.name,
 * (buyer email + createdAt), (order, product). Second run does not duplicate.
 */
async function seed(): Promise<void> {
	await dataSource.initialize()
	const userRepo = dataSource.getRepository(User)
	const categoryRepo = dataSource.getRepository(Category)
	const productRepo = dataSource.getRepository(Product)
	const orderRepo = dataSource.getRepository(Order)
	const itemRepo = dataSource.getRepository(OrderItem)

	await userRepo.upsert(USERS, ['email'])
	await categoryRepo.upsert(CATEGORIES, ['slug'])

	const users = await userRepo.find()
	const categories = await categoryRepo.find()
	const userByEmail = new Map(users.map((user) => [user.email, user]))
	const categoryBySlug = new Map(
		categories.map((category) => [category.slug, category]),
	)

	for (const row of PRODUCTS) {
		const seller = userByEmail.get(row.sellerEmail)
		const category = categoryBySlug.get(row.categorySlug)
		if (!seller || !category) {
			throw new Error(`Missing seller or category for ${row.name}`)
		}
		await productRepo.upsert(
			{
				name: row.name,
				description: row.description,
				priceCents: row.priceCents,
				stock: row.stock,
				seller,
				category,
			},
			['name'],
		)
	}

	const products = await productRepo.find()
	const productByName = new Map(
		products.map((product) => [product.name, product]),
	)

	for (const row of ORDERS) {
		const buyer = userByEmail.get(row.buyerEmail)
		if (!buyer) {
			throw new Error(`Missing buyer ${row.buyerEmail}`)
		}
		let order = await orderRepo.findOne({
			where: { user: { id: buyer.id }, createdAt: row.createdAt },
		})
		if (!order) {
			order = await orderRepo.save(
				orderRepo.create({
					user: buyer,
					status: row.status,
					createdAt: row.createdAt,
					totalCents: 0,
				}),
			)
		} else if (order.status !== row.status) {
			order.status = row.status
			await orderRepo.save(order)
		}

		for (const item of row.items) {
			const product = productByName.get(item.productName)
			if (!product) {
				throw new Error(`Missing product ${item.productName}`)
			}
			await itemRepo.upsert(
				{
					order: { id: order.id },
					product: { id: product.id },
					quantity: item.quantity,
					unitPriceCents: product.priceCents,
				},
				['order', 'product'],
			)
		}

		const totals = await itemRepo
			.createQueryBuilder('item')
			.select('COALESCE(SUM(item.quantity * item.unitPriceCents), 0)', 'total')
			.where('item.order_id = :orderId', { orderId: order.id })
			.getRawOne<{ total: string }>()
		order.totalCents = Number(totals?.total ?? 0)
		await orderRepo.save(order)
	}

	const counts = {
		users: await userRepo.count(),
		categories: await categoryRepo.count(),
		products: await productRepo.count(),
		orders: await orderRepo.count(),
		order_items: await itemRepo.count(),
	}
	console.log('seed counts', counts)
}

seed()
	.catch((err: unknown) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(async () => {
		if (dataSource.isInitialized) {
			await dataSource.destroy()
		}
	})
