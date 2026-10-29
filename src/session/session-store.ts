import { randomUUID } from 'crypto'
import type Redis from 'ioredis'

export interface SessionRecord {
	userId: string
}

/**
 * Session token in Redis with a rolling TTL.
 * Pass the queue Redis (noeviction). The cache instance is allkeys-lru
 * and will eventually drop a live session.
 */
export class SessionStore {
	constructor(
		private readonly redis: Redis,
		readonly ttlSeconds: number,
	) {}

	key(sessionId: string): string {
		return `session:${sessionId}`
	}

	/** Creates a session. The id is the only credential the client holds. */
	async start(userId: string): Promise<string> {
		const sessionId = randomUUID()
		const record: SessionRecord = { userId }
		await this.redis.set(
			this.key(sessionId),
			JSON.stringify(record),
			'EX',
			this.ttlSeconds,
		)
		return sessionId
	}

	/**
	 * Reads the session and extends its TTL. GETEX is one round-trip:
	 * an active user is not logged out mid-request.
	 */
	async touch(sessionId: string): Promise<SessionRecord | null> {
		const raw = await this.redis.getex(
			this.key(sessionId),
			'EX',
			this.ttlSeconds,
		)
		if (raw === null) {
			return null
		}
		return JSON.parse(raw) as SessionRecord
	}

	/** Remaining TTL in seconds. Does not renew. */
	async remainingTtl(sessionId: string): Promise<number> {
		return this.redis.ttl(this.key(sessionId))
	}

	async end(sessionId: string): Promise<void> {
		await this.redis.del(this.key(sessionId))
	}

	async exists(sessionId: string): Promise<boolean> {
		const found = await this.redis.exists(this.key(sessionId))
		return found === 1
	}
}
