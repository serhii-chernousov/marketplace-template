import {
	Counter,
	Histogram,
	Registry,
	collectDefaultMetrics,
} from 'prom-client'

export const registry = new Registry()
collectDefaultMetrics({ register: registry })

const labelNames = ['method', 'route', 'status'] as const

export const httpRequests = new Counter({
	name: 'http_requests_total',
	help: 'HTTP requests by method, route template and status code',
	labelNames,
	registers: [registry],
})

/**
 * Top finite bucket is 2 × TIMEOUT_MS (5 s): no request outlives the timeout,
 * so histogram_quantile never flattens against the last bucket.
 */
export const DURATION_BUCKETS = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]

export const httpDuration = new Histogram({
	name: 'http_request_duration_seconds',
	help: 'HTTP request duration by method, route template and status code',
	labelNames,
	buckets: DURATION_BUCKETS,
	registers: [registry],
})
