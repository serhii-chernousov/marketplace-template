import { randomUUID } from 'node:crypto'
import type { DataSource } from 'typeorm'
import { printMetrics } from './print-metrics'
import {
	meetsExpectations,
	resetDemoAccounts,
	runDemo,
	startDemoApp,
	type DemoAccount,
} from './auth-demo-kit'

const PORT = 3403

const EXPECTED = {
	anon: [401],
	own: [200],
	foreign: [403],
	'role-denied': [403],
	'role-allowed': [200, 201],
	tampered: [401],
}

/** Payload swapped, signature kept: a server that only decodes the JWT would accept it. */
function tamperRole(token: string, role: string): string {
	const [header, payload, signature] = token.split('.')
	const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
	claims.role = role
	const forged = Buffer.from(JSON.stringify(claims)).toString('base64url')
	return [header, forged, signature].join('.')
}

async function insertOrder(
	dataSource: DataSource,
	buyer: DemoAccount,
	seller: DemoAccount,
): Promise<string> {
	const [product]: Array<{ id: string }> = await dataSource.query(
		`INSERT INTO products (name, price_cents, stock, seller_id)
		 VALUES ($1, 1500, 10, $2) RETURNING id`,
		[`rbac-demo-${randomUUID()}`, seller.id],
	)
	const [order]: Array<{ id: string }> = await dataSource.query(
		`INSERT INTO orders (user_id, status, total_cents)
		 VALUES ($1, 'paid', 1500) RETURNING id`,
		[buyer.id],
	)
	await dataSource.query(
		`INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
		 VALUES ($1, $2, 1, 1500)`,
		[order.id, product.id],
	)
	return `order-${order.id}`
}

/**
 * Authentication (401: who are you?) against authorization (403: you may not).
 * Role is checked by a guard; ownership needs the loaded order, so it is
 * checked in the service — foreign=403 under a perfectly valid token.
 */
runDemo(async () => {
	const { app, dataSource, call } = await startDemoApp(PORT)
	try {
		const [buyer, otherBuyer, seller] = await resetDemoAccounts(dataSource, [
			{ email: 'demo-rbac-buyer@shop.local', role: 'buyer' },
			{ email: 'demo-rbac-other-buyer@shop.local', role: 'buyer' },
			{ email: 'demo-rbac-seller@shop.local', role: 'seller' },
		])
		const orderId = await insertOrder(dataSource, buyer, seller)
		const tokenOf = async (account: DemoAccount) => {
			const login = await call('POST', '/v1/auth/login', {
				body: { email: account.email, password: account.password },
			})
			return String(login.body.access_token)
		}
		const buyerToken = await tokenOf(buyer)
		const otherBuyerToken = await tokenOf(otherBuyer)
		const sellerToken = await tokenOf(seller)
		const newProduct = () => ({
			name: `rbac-demo-${randomUUID()}`,
			price_cents: 2500,
			stock: 3,
		})

		const anon = await call('GET', `/v1/orders/${orderId}`)
		const own = await call('GET', `/v1/orders/${orderId}`, {
			token: buyerToken,
		})
		const foreign = await call('GET', `/v1/orders/${orderId}`, {
			token: otherBuyerToken,
		})
		const roleDenied = await call('POST', '/v1/products', {
			token: buyerToken,
			body: newProduct(),
		})
		const roleAllowed = await call('POST', '/v1/products', {
			token: sellerToken,
			body: newProduct(),
		})
		const tampered = await call('POST', '/v1/products', {
			token: tamperRole(buyerToken, 'admin'),
			body: newProduct(),
		})

		const metrics = {
			anon: anon.status,
			own: own.status,
			foreign: foreign.status,
			'role-denied': roleDenied.status,
			'role-allowed': roleAllowed.status,
			tampered: tampered.status,
		}
		printMetrics(metrics)
		return meetsExpectations(metrics, EXPECTED) ? 0 : 1
	} finally {
		await app.close()
	}
})
