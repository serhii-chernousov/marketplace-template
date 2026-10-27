import Redis from 'ioredis'

/** Cache instance: maxmemory + allkeys-lru. Not safe for sessions. */
export function requireRedisUrl(): string {
	const url = process.env.REDIS_URL?.trim()
	if (!url) {
		throw new Error('REDIS_URL is required')
	}
	return url
}

/**
 * Queue instance: maxmemory-policy noeviction.
 * Sessions and the rate-limit counter live here too — the cache
 * instance may evict any key, and a vanished session is a logout
 * nobody can reproduce.
 */
export function requireRedisQueueUrl(): string {
	const url = process.env.REDIS_QUEUE_URL?.trim()
	if (!url) {
		throw new Error('REDIS_QUEUE_URL is required')
	}
	return url
}

/** Short-lived client for demos and one-off reads. */
export function createRedis(url: string): Redis {
	return new Redis(url, { maxRetriesPerRequest: 2 })
}

/** CONFIG GET value. Redis replies with [name, value]. */
export async function redisConfig(
	redis: Redis,
	parameter: string,
): Promise<string> {
	const reply = await redis.call('CONFIG', 'GET', parameter)
	if (!Array.isArray(reply) || reply.length < 2) {
		throw new Error(`CONFIG GET ${parameter} returned nothing`)
	}
	return String(reply[1])
}
