import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { DataSource } from 'typeorm'
import dataSource from '../database/data-source'
import { type DemoAccount, resetDemoAccounts } from './auth-demo-kit'

export type LogLine = Record<string, unknown>

export interface CallOptions {
	token?: string
	body?: unknown
	headers?: Record<string, string>
}

export interface CallResult {
	status: number
	body: Record<string, unknown>
}

export interface AppProcess {
	/** Every stdout line of the app, raw. */
	lines: string[]
	call: (
		method: string,
		path: string,
		options?: CallOptions,
	) => Promise<CallResult>
	/** Resolves undefined on timeout so a demo still prints its numbers (as 0). */
	waitForLog: (
		match: (line: LogLine) => boolean,
		timeoutMs?: number,
	) => Promise<LogLine | undefined>
	stop: () => Promise<void>
}

/**
 * The app runs as a separate `node dist/main.js`, exactly as in production:
 * its stdout is the log stream under test and stays apart from the demo's own
 * key=number output, and OpenTelemetry is loaded the way main.ts loads it.
 */
export async function spawnApp(
	port: number,
	env: Record<string, string> = {},
): Promise<AppProcess> {
	setTimeout(() => {
		console.error('demo timed out')
		process.exit(1)
	}, 90_000).unref()

	const child = spawn(process.execPath, [join(__dirname, '..', 'main.js')], {
		env: {
			...process.env,
			PORT: String(port),
			LOG_LEVEL: 'debug',
			FAULT_INJECTION: '1',
			WARMUP_MS: '0',
			DRAIN_MS: '0',
			...env,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const lines: string[] = []
	const stderr: string[] = []
	createInterface({ input: child.stdout! }).on('line', (line) =>
		lines.push(line),
	)
	createInterface({ input: child.stderr! }).on('line', (line) =>
		stderr.push(line),
	)
	const exited = new Promise<number | null>((resolve) =>
		child.once('exit', (code) => resolve(code)),
	)

	const baseUrl = `http://127.0.0.1:${port}`
	await waitUntilReady(baseUrl, child, () => [...stderr, ...lines].slice(-20))

	return {
		lines,
		call: (method, path, options) => request(baseUrl, method, path, options),
		waitForLog: (match, timeoutMs = 3_000) =>
			poll(
				() => parseJsonLines(lines).json.find(match),
				timeoutMs,
				'log line',
			).catch(() => undefined),
		stop: async () => {
			if (child.exitCode === null) {
				child.kill('SIGTERM')
				await exited
			}
		},
	}
}

async function waitUntilReady(
	baseUrl: string,
	child: ChildProcess,
	tail: () => string[],
): Promise<void> {
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(
				`app exited with ${child.exitCode}:\n${tail().join('\n')}`,
			)
		}
		const ready = await fetch(`${baseUrl}/readyz`)
			.then((res) => res.status === 200)
			.catch(() => false)
		if (ready) {
			return
		}
		await sleep(200)
	}
	child.kill('SIGKILL')
	throw new Error(`app not ready in 30s:\n${tail().join('\n')}`)
}

async function request(
	baseUrl: string,
	method: string,
	path: string,
	{ token, body, headers }: CallOptions = {},
): Promise<CallResult> {
	const res = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await res.text()
	let parsed: Record<string, unknown> = {}
	try {
		parsed = text ? JSON.parse(text) : {}
	} catch {
		parsed = { raw: text }
	}
	return { status: res.status, body: parsed }
}

export function parseJsonLines(lines: string[]): {
	json: LogLine[]
	nonJson: number
} {
	const json: LogLine[] = []
	let nonJson = 0
	for (const line of lines) {
		if (!line.trim()) {
			continue
		}
		try {
			const value: unknown = JSON.parse(line)
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				json.push(value as LogLine)
			} else {
				nonJson++
			}
		} catch {
			nonJson++
		}
	}
	return { json, nonJson }
}

export interface Traceparent {
	traceId: string
	parentId: string
	header: string
}

/** W3C Trace Context: 00-<32 hex trace-id>-<16 hex parent-id>-01 (sampled). */
export function newTraceparent(): Traceparent {
	const traceId = randomBytes(16).toString('hex')
	const parentId = randomBytes(8).toString('hex')
	return { traceId, parentId, header: `00-${traceId}-${parentId}-01` }
}

export async function poll<T>(
	read: () => T | undefined | Promise<T | undefined>,
	timeoutMs: number,
	what: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const value = await read()
		if (value !== undefined) {
			return value
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`)
		}
		await sleep(100)
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function openDb(): Promise<DataSource> {
	return dataSource.isInitialized ? dataSource : dataSource.initialize()
}

export interface OrderFixture {
	buyer: DemoAccount
	orderId: string
}

/** Fresh demo accounts plus one order the buyer owns: GET /v1/orders/:id → 200. */
export async function prepareOrderFixture(
	db: DataSource,
	prefix: string,
): Promise<OrderFixture> {
	const [buyer, seller] = await resetDemoAccounts(db, [
		{ email: `${prefix}-buyer@shop.local`, role: 'buyer' },
		{ email: `${prefix}-seller@shop.local`, role: 'seller' },
	])
	const [product]: Array<{ id: string }> = await db.query(
		`INSERT INTO products (name, price_cents, stock, seller_id)
		 VALUES ($1, 1500, 10, $2) RETURNING id`,
		[`${prefix}-${randomUUID()}`, seller.id],
	)
	const [order]: Array<{ id: string }> = await db.query(
		`INSERT INTO orders (user_id, status, total_cents)
		 VALUES ($1, 'paid', 1500) RETURNING id`,
		[buyer.id],
	)
	await db.query(
		`INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
		 VALUES ($1, $2, 1, 1500)`,
		[order.id, product.id],
	)
	return { buyer, orderId: `order-${order.id}` }
}

/**
 * The access log is written on 'finish', which can land after the client has
 * the response; waiting for it keeps the login line out of later log windows.
 */
export async function login(
	app: AppProcess,
	account: DemoAccount,
): Promise<string> {
	const tp = newTraceparent()
	const res = await app.call('POST', '/v1/auth/login', {
		body: { email: account.email, password: account.password },
		headers: { traceparent: tp.header },
	})
	if (res.status !== 200) {
		throw new Error(`login failed with ${res.status}`)
	}
	await app.waitForLog(
		(line) => line.layer === 'http' && line.trace_id === tp.traceId,
	)
	return String(res.body.access_token)
}
