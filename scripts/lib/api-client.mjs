export const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
// Same dev-only default as docker-compose.yaml; seeded users get it from SEED_PASSWORD.
export const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'marketplace-dev'

async function call(method, path, { token, body, headers = {} } = {}) {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: {
			...(body ? { 'Content-Type': 'application/json' } : {}),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...headers,
		},
		body: body ? JSON.stringify(body) : undefined,
	})
	const text = await res.text()
	return {
		status: res.status,
		headers: res.headers,
		body: text ? JSON.parse(text) : undefined,
	}
}

export async function login(email) {
	const res = await call('POST', '/v1/auth/login', {
		body: { email, password: SEED_PASSWORD },
	})
	if (res.status !== 200) {
		throw new Error(
			`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`,
		)
	}
	return res.body.access_token
}

export function createOrder(token, idempotencyKey, listingId = 'listing-1') {
	return call('POST', '/v1/orders', {
		token,
		headers: { 'Idempotency-Key': idempotencyKey },
		body: { items: [{ listing_id: listingId, quantity: 1 }] },
	})
}

export function getOrder(token, orderId) {
	return call('GET', `/v1/orders/${orderId}`, { token })
}

export function patchStatus(token, orderId, status) {
	return call('PATCH', `/v1/orders/${orderId}/status`, {
		token,
		body: { status },
	})
}

export async function waitForStatus(
	token,
	orderId,
	expected,
	timeoutMs = 15_000,
) {
	const deadline = Date.now() + timeoutMs
	let status
	while (Date.now() < deadline) {
		status = (await getOrder(token, orderId)).body?.status
		if (status === expected) {
			return status
		}
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	return status
}
