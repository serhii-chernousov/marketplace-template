import { randomUUID } from 'crypto'
import { printMetrics } from './print-metrics'
import { SlidingWindowLimiter } from '../ratelimit/sliding-window-limiter'
import { createRedis, requireRedisQueueUrl } from '../redis/redis'

const LIMIT = 5
const WINDOW_MS = 10_000
const EXTRA = 3

/**
 * Two limiter instances, one Redis key.
 * A process-local counter would allow LIMIT on each instance.
 */
async function main(): Promise<void> {
	const url = requireRedisQueueUrl()
	const podARedis = createRedis(url)
	const podBRedis = createRedis(url)
	const bucket = `checkout:${randomUUID()}`
	let exitCode = 1

	try {
		const pods = [
			new SlidingWindowLimiter(podARedis),
			new SlidingWindowLimiter(podBRedis),
		]
		let requests = 0
		let allowed = 0
		let blocked = 0
		let status = 0
		let retryAfter = 0

		for (let index = 0; index < LIMIT + EXTRA; index += 1) {
			const pod = pods[index % pods.length]
			const response = await pod.consume(bucket, {
				limit: LIMIT,
				windowMs: WINDOW_MS,
			})
			requests += 1
			if (response.allowed) {
				allowed += 1
				continue
			}
			blocked += 1
			status = response.status
			retryAfter = response.headers['Retry-After'] ? 1 : 0
		}

		const metrics = {
			instances: pods.length,
			limit: LIMIT,
			requests,
			allowed,
			blocked,
			status,
			'retry-after': retryAfter,
		}
		printMetrics(metrics)
		exitCode =
			metrics.instances >= 2 &&
			metrics.limit > 0 &&
			metrics.allowed === metrics.limit &&
			metrics.blocked >= 1 &&
			metrics.status === 429 &&
			metrics['retry-after'] === 1
				? 0
				: 1
	} finally {
		await podARedis.del(`rl:${bucket}`)
		await podARedis.quit()
		await podBRedis.quit()
	}

	process.exit(exitCode)
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err)
	console.error(message)
	process.exit(1)
})
