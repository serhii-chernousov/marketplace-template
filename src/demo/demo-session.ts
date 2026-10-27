import { printMetrics } from './print-metrics'
import { sleep } from '../common/sleep'
import { createRedis, requireRedisQueueUrl } from '../redis/redis'
import { SessionStore } from '../session/session-store'

const SESSION_TTL_SEC = 15
const IDLE_MS = 2000

/**
 * One session, three requests, rolling TTL on the queue Redis.
 * The pause is long enough for TTL to tick down before the next touch.
 */
async function main(): Promise<void> {
	const redis = createRedis(requireRedisQueueUrl())
	const store = new SessionStore(redis, SESSION_TTL_SEC)
	let sessionId = ''
	let exitCode = 1

	try {
		const seen = new Set<string>()
		let requests = 0

		const request = async (id: string): Promise<void> => {
			requests += 1
			const record = await store.touch(id)
			if (!record) {
				throw new Error('session missing on request')
			}
			seen.add(id)
		}

		sessionId = await store.start('buyer-1')
		await request(sessionId)
		await sleep(IDLE_MS)
		const ttlBefore = await store.remainingTtl(sessionId)
		await request(sessionId)
		const ttlAfter = await store.remainingTtl(sessionId)
		await request(sessionId)

		const metrics = {
			requests,
			sessions: seen.size,
			'in-redis': (await store.exists(sessionId)) ? 1 : 0,
			'ttl-renewed': ttlAfter > ttlBefore ? 1 : 0,
		}
		printMetrics(metrics)
		exitCode =
			metrics.sessions === 1 &&
			metrics['in-redis'] === 1 &&
			metrics['ttl-renewed'] === 1 &&
			metrics.requests >= 3
				? 0
				: 1
	} finally {
		if (sessionId) {
			await redis.del(store.key(sessionId))
		}
		await redis.quit()
	}

	process.exit(exitCode)
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err)
	console.error(message)
	process.exit(1)
})
