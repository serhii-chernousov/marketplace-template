import { meetsExpectations, runDemo } from './auth-demo-kit'
import {
	type AppProcess,
	login,
	openDb,
	poll,
	prepareOrderFixture,
	spawnApp,
} from './observability-kit'
import { printMetrics } from './print-metrics'

const PORT = 3412
const ROUTE = '/v1/orders/:id'
const DISTINCT_IDS = 100
const FAILURES = 10
const SLOW = [{ delayMs: 1500 }, { delayMs: 2500 }]
const TOP_BUCKET = '10'

/** Informational: the stand's Prometheus scrapes this demo's port too, so the dashboard moves. */
async function prometheusSeesTarget(): Promise<number> {
	const base = process.env.PROMETHEUS_URL
	if (!base) {
		return 0
	}
	const query = encodeURIComponent(
		`up{instance="host.docker.internal:${PORT}"}`,
	)
	const read = async () => {
		const res = await fetch(
			`${base.replace(/\/$/, '')}/api/v1/query?query=${query}`,
		)
		const json = (await res.json()) as {
			data?: { result?: Array<{ value: [number, string] }> }
		}
		return json.data?.result?.[0]?.value[1] === '1' ? 1 : undefined
	}
	return poll(read, 8_000, 'prometheus scrape').catch(() => 0)
}

interface Sample {
	name: string
	labels: Record<string, string>
	value: number
}

function parseExposition(text: string): Sample[] {
	const samples: Sample[] = []
	for (const line of text.split('\n')) {
		const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line)
		if (!match) {
			continue
		}
		const labels: Record<string, string> = {}
		for (const [, key, value] of (match[2] ?? '').matchAll(
			/(\w+)="((?:[^"\\]|\\.)*)"/g,
		)) {
			labels[key] = value
		}
		samples.push({ name: match[1], labels, value: Number(match[3]) })
	}
	return samples
}

async function scrape(app: AppProcess): Promise<Sample[]> {
	const res = await app.call('GET', '/metrics')
	return parseExposition(String(res.body.raw ?? ''))
}

function sum(
	samples: Sample[],
	name: string,
	where: (labels: Record<string, string>) => boolean,
): number {
	return samples
		.filter((s) => s.name === name && where(s.labels))
		.reduce((total, s) => total + s.value, 0)
}

const onRoute = (labels: Record<string, string>) => labels.route === ROUTE
const isServerError = (labels: Record<string, string>) =>
	onRoute(labels) && labels.status.startsWith('5')
const counterSeries = (samples: Sample[]) =>
	samples.filter((s) => s.name === 'http_requests_total').length

/**
 * RED counts what actually happened, and the route label is bounded:
 * a hundred distinct ids on /v1/orders/:id add no new time series.
 */
runDemo(async () => {
	const db = await openDb()
	const app = await spawnApp(PORT)
	try {
		const { buyer, orderId } = await prepareOrderFixture(db, 'demo-metrics')
		const token = await login(app, buyer)
		const get = (id: string, headers: Record<string, string> = {}) =>
			app.call('GET', `/v1/orders/${id}`, { token, headers })

		const before = await scrape(app)
		let sentOk = 0
		let sentFail = 0
		const count = (status: number) => (status >= 500 ? sentFail++ : sentOk++)

		count((await get('order-999999990')).status)
		const seriesBefore = counterSeries(await scrape(app))
		for (let i = 1; i <= DISTINCT_IDS; i++) {
			count((await get(`order-${999_000_000 + i}`)).status)
		}
		const seriesAfter = counterSeries(await scrape(app))

		for (let i = 0; i < FAILURES; i++) {
			count((await get(orderId, { 'x-fault': '500' })).status)
		}
		for (const { delayMs } of SLOW) {
			count(
				(await get(orderId, { 'x-fault-delay-ms': String(delayMs) })).status,
			)
		}
		const after = await scrape(app)
		const prometheusUp = await prometheusSeesTarget()

		const counterDelta =
			sum(after, 'http_requests_total', onRoute) -
			sum(before, 'http_requests_total', onRoute)
		const errorsDelta =
			sum(after, 'http_requests_total', isServerError) -
			sum(before, 'http_requests_total', isServerError)
		const aboveTopBucket =
			sum(after, 'http_request_duration_seconds_count', onRoute) -
			sum(
				after,
				'http_request_duration_seconds_bucket',
				(labels) => onRoute(labels) && labels.le === TOP_BUCKET,
			)

		const metrics = {
			'sent-ok': sentOk,
			'sent-fail': sentFail,
			'counter-delta': counterDelta,
			'errors-delta': errorsDelta,
			'above-top-bucket': aboveTopBucket,
			'series-before': seriesBefore,
			'series-after': seriesAfter,
			'prometheus-target-up': prometheusUp,
		}
		printMetrics(metrics)
		const total = sentOk + sentFail
		const ok = meetsExpectations(metrics, {
			'counter-delta': [total],
			'errors-delta': [sentFail],
			'above-top-bucket': [0],
			'series-after': [seriesBefore],
		})
		if (total < 50) {
			console.error(`invariant broken: sent=${total} (expected >= 50)`)
		}
		return ok && total >= 50 && sentFail > 0 ? 0 : 1
	} finally {
		await app.stop()
		await db.destroy()
	}
})
