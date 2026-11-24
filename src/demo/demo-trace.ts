import { randomUUID } from 'node:crypto'
import type { DataSource } from 'typeorm'
import { meetsExpectations, runDemo } from './auth-demo-kit'
import {
	login,
	newTraceparent,
	openDb,
	poll,
	prepareOrderFixture,
	sleep,
	spawnApp,
} from './observability-kit'
import { printMetrics } from './print-metrics'

const PORT = 3413
const LISTING = 'listing-1'
const LISTING_PRODUCT = 'Vintage Lamp'
const MIN_SPANS = 2

interface JaegerSpan {
	traceID: string
	spanID: string
	operationName: string
	references?: Array<{ refType: string; spanID: string }>
	tags?: Array<{ key: string; value: unknown }>
}

/**
 * POST /v1/orders resolves listing-1 to the "Vintage Lamp" product by name,
 * so the product has to exist and the buyer has to afford it for checkout to
 * reach its SQL before the injected fault aborts the transaction.
 */
async function prepareCheckout(db: DataSource, buyerId: string): Promise<void> {
	const [seller]: Array<{ id: string }> = await db.query(
		`INSERT INTO users (email, full_name, role, is_active)
		 VALUES ('demo-trace-catalog@shop.local', 'Demo catalog', 'seller', true)
		 ON CONFLICT (email) DO UPDATE SET is_active = true
		 RETURNING id`,
	)
	await db.query(
		`INSERT INTO products (name, description, price_cents, stock, is_active, seller_id)
		 VALUES ($1, '', 4599, 12, true, $2)
		 ON CONFLICT (name) DO UPDATE
		   SET stock = GREATEST(products.stock, 1), is_active = true`,
		[LISTING_PRODUCT, seller.id],
	)
	await db.query(`UPDATE users SET balance_cents = 100000000 WHERE id = $1`, [
		buyerId,
	])
}

const tag = (span: JaegerSpan, key: string) =>
	span.tags?.find((t) => t.key === key)?.value
const parentOf = (span: JaegerSpan) =>
	span.references?.find((ref) => ref.refType === 'CHILD_OF')?.spanID
const hex = (id: string, width: number) => id.toLowerCase().padStart(width, '0')

async function fetchTrace(traceId: string): Promise<JaegerSpan[]> {
	const base = process.env.TRACE_API_URL
	if (!base) {
		throw new Error('TRACE_API_URL is not set')
	}
	const res = await fetch(`${base.replace(/\/$/, '')}/api/traces/${traceId}`)
	if (!res.ok) {
		return []
	}
	const json = (await res.json()) as { data?: Array<{ spans: JaegerSpan[] }> }
	return json.data?.[0]?.spans ?? []
}

/**
 * One key opens two doors: the trace_id that arrived in traceparent is the
 * trace_id of the server span in Jaeger and the trace_id in the log line of
 * the same failed request.
 */
runDemo(async () => {
	const db = await openDb()
	const app = await spawnApp(PORT)
	let stopped = false
	try {
		const { buyer } = await prepareOrderFixture(db, 'demo-trace')
		await prepareCheckout(db, buyer.id)
		const token = await login(app, buyer)

		const tp = newTraceparent()
		const idempotencyKey = `demo-trace-${randomUUID()}`
		const res = await app.call('POST', '/v1/orders', {
			token,
			headers: {
				traceparent: tp.header,
				'Idempotency-Key': idempotencyKey,
				'x-fault': '500',
			},
			body: { items: [{ listing_id: LISTING, quantity: 1 }] },
		})
		if (res.status !== 500) {
			throw new Error(
				`expected 500 from the faulty checkout, got ${res.status}`,
			)
		}
		// Found by the idempotency key from request context, not by trace_id,
		// so the comparison with the span below is not circular.
		const accessLog = await app.waitForLog(
			(line) => line.layer === 'http' && line.idempotencyKey === idempotencyKey,
		)
		const logTraceId = String(accessLog?.trace_id ?? '')

		// SIGTERM runs the SDK shutdown, which flushes the batch span processor.
		await app.stop()
		stopped = true
		await poll(
			async () =>
				(await fetchTrace(tp.traceId)).length >= MIN_SPANS ? true : undefined,
			20_000,
			'spans in Jaeger',
		).catch(() => false)
		await sleep(1_000)
		const settled = await fetchTrace(tp.traceId)

		const ids = new Set(settled.map((span) => hex(span.spanID, 16)))
		const server = settled.find(
			(span) =>
				tag(span, 'span.kind') === 'server' &&
				parentOf(span) &&
				hex(parentOf(span)!, 16) === tp.parentId,
		)
		const orphans = settled.filter((span) => {
			const parent = parentOf(span)
			return (
				parent !== undefined &&
				!ids.has(hex(parent, 16)) &&
				hex(parent, 16) !== tp.parentId
			)
		})
		const spanTraceId = server ? hex(server.traceID, 32) : ''

		const metrics = {
			status: res.status,
			spans: settled.length,
			'orphan-spans': orphans.length,
			'trace-matches-header': Number(spanTraceId === tp.traceId),
			'trace-matches-log': Number(
				spanTraceId !== '' && spanTraceId === logTraceId,
			),
			'span-status-error': Number(
				server !== undefined && tag(server, 'otel.status_code') === 'ERROR',
			),
		}
		printMetrics(metrics)
		const ok = meetsExpectations(metrics, {
			'orphan-spans': [0],
			'trace-matches-header': [1],
			'trace-matches-log': [1],
			'span-status-error': [1],
		})
		if (metrics.spans < MIN_SPANS) {
			console.error(
				`invariant broken: spans=${metrics.spans} (expected >= ${MIN_SPANS})`,
			)
		}
		return ok && metrics.spans >= MIN_SPANS ? 0 : 1
	} finally {
		if (!stopped) {
			await app.stop()
		}
		await db.destroy()
	}
})
