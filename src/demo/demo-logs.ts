import { randomBytes } from 'node:crypto'
import { meetsExpectations, runDemo } from './auth-demo-kit'
import {
	type LogLine,
	login,
	newTraceparent,
	openDb,
	parseJsonLines,
	prepareOrderFixture,
	spawnApp,
} from './observability-kit'
import { printMetrics } from './print-metrics'

const PORT = 3411
const BURST = 12

function groupByTrace(lines: LogLine[]): Map<string, LogLine[]> {
	const groups = new Map<string, LogLine[]>()
	for (const line of lines) {
		if (typeof line.trace_id !== 'string') {
			continue
		}
		const group = groups.get(line.trace_id) ?? []
		group.push(line)
		groups.set(line.trace_id, group)
	}
	return groups
}

function isAccessLogOf(traceId: string) {
	return (line: LogLine) => line.layer === 'http' && line.trace_id === traceId
}

/**
 * The correlator lives in context, not in arguments: one request yields one
 * trace_id across controller → service → repository, BURST parallel requests
 * yield BURST equal-sized groups, and secrets from the request never reach
 * the log stream.
 */
runDemo(async () => {
	const db = await openDb()
	const app = await spawnApp(PORT)
	try {
		const { buyer, orderId } = await prepareOrderFixture(db, 'demo-logs')
		const token = await login(app, buyer)

		const single = newTraceparent()
		const singleStart = app.lines.length
		await app.call('GET', `/v1/orders/${orderId}`, {
			token,
			headers: { traceparent: single.header },
		})
		await app.waitForLog(isAccessLogOf(single.traceId))
		const singleLines = parseJsonLines(app.lines.slice(singleStart)).json
		const singleIds = new Set(
			singleLines.map((line) => line.trace_id).filter(Boolean),
		)
		const layers = new Set(
			singleLines
				.filter((line) => line.trace_id === single.traceId)
				.map((line) => line.layer),
		)

		const burst = Array.from({ length: BURST }, () => newTraceparent())
		await Promise.all(
			burst.map((tp) =>
				app.call('GET', `/v1/orders/${orderId}`, {
					token,
					headers: { traceparent: tp.header },
				}),
			),
		)
		await Promise.all(
			burst.map((tp) => app.waitForLog(isAccessLogOf(tp.traceId))),
		)
		const sent = new Set(burst.map((tp) => tp.traceId))
		const groups = [...groupByTrace(parseJsonLines(app.lines).json)]
			.filter(([traceId]) => sent.has(traceId))
			.map(([, group]) => group.length)
		const uneven = groups.filter((size) => size !== groups[0]).length

		const tokenMarker = `tok-${randomBytes(12).toString('hex')}`
		const passwordMarker = `pw-${randomBytes(12).toString('hex')}`
		const secret = newTraceparent()
		await app.call('POST', '/v1/auth/login', {
			headers: {
				authorization: `Bearer ${tokenMarker}`,
				traceparent: secret.header,
			},
			body: { email: buyer.email, password: passwordMarker },
		})
		await app.waitForLog(isAccessLogOf(secret.traceId))
		const raw = app.lines.join('\n')

		const metrics = {
			'non-json-lines': parseJsonLines(app.lines).nonJson,
			layers: layers.size,
			'distinct-trace-ids': singleIds.size,
			'trace-id-matches-header': Number(
				singleIds.size === 1 && singleIds.has(single.traceId),
			),
			burst: BURST,
			'burst-trace-ids': groups.length,
			'burst-uneven': uneven,
			'secret-req-logged': Number(
				parseJsonLines(app.lines).json.some(isAccessLogOf(secret.traceId)),
			),
			'secret-in-logs': Number(
				raw.includes(tokenMarker) || raw.includes(passwordMarker),
			),
		}
		printMetrics(metrics)
		const ok =
			meetsExpectations(metrics, {
				'non-json-lines': [0],
				'distinct-trace-ids': [1],
				'trace-id-matches-header': [1],
				'burst-trace-ids': [BURST],
				'burst-uneven': [0],
				'secret-req-logged': [1],
				'secret-in-logs': [0],
			}) && metrics.layers >= 3
		if (metrics.layers < 3) {
			console.error(
				`invariant broken: layers=${metrics.layers} (expected >= 3)`,
			)
		}
		return ok ? 0 : 1
	} finally {
		await app.stop()
		await db.destroy()
	}
})
