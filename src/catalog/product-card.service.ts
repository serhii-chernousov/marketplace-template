import { randomUUID } from 'crypto'
import { Inject, Injectable } from '@nestjs/common'
import type Redis from 'ioredis'
import { sleep } from '../common/sleep'
import { CACHE_REDIS } from '../redis/redis.module'
import {
	ProductCardRepository,
	type ProductCard,
} from './product-card.repository'

const CACHE_TTL_BASE_SEC = 300
const CACHE_TTL_JITTER_SEC = 60
const LOCK_TTL_MS = 5000
const WAIT_POLL_MS = 20
/**
 * Cover the whole lock. A SELECT that returns while the lock is still
 * held writes the card; a shorter budget throws before that write.
 */
const WAIT_POLLS = Math.ceil(LOCK_TTL_MS / WAIT_POLL_MS)

const UNLOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
	return redis.call("del", KEYS[1])
else
	return 0
end
`

interface CachedProductCard {
	found: boolean
	card: ProductCard | null
}

/**
 * TTL with at least 10s of spread so a warmup cycle does not expire
 * in the same second.
 */
export function cacheTtlSeconds(random: () => number = Math.random): number {
	return CACHE_TTL_BASE_SEC + Math.floor(random() * (CACHE_TTL_JITTER_SEC + 1))
}

export function productCardKey(productId: string): string {
	return `product-card:${productId}`
}

export function productCardLockKey(productId: string): string {
	return `lock:product-card:${productId}`
}

/**
 * Cache-aside with a single-flight lock.
 * The lock is an optimization: if it breaks, two requests both read
 * Postgres. It does not protect a business invariant.
 * Injectable in Nest; demos may also `new ProductCardService(redis, repository)`.
 */
@Injectable()
export class ProductCardService {
	constructor(
		@Inject(CACHE_REDIS) private readonly redis: Redis,
		private readonly repository: ProductCardRepository,
	) {}

	async getCard(productId: string): Promise<ProductCard | null> {
		const key = productCardKey(productId)
		const cached = await this.readCache(key)
		if (cached !== undefined) {
			return cached
		}

		const token = randomUUID()
		const lockKey = productCardLockKey(productId)
		const acquired = await this.redis.set(
			lockKey,
			token,
			'PX',
			LOCK_TTL_MS,
			'NX',
		)
		if (acquired === 'OK') {
			try {
				const again = await this.readCache(key)
				if (again !== undefined) {
					return again
				}
				const card = await this.repository.load(productId)
				await this.writeCache(key, card)
				return card
			} finally {
				await this.redis.eval(UNLOCK_LUA, 1, lockKey, token)
			}
		}

		for (let attempt = 0; attempt < WAIT_POLLS; attempt += 1) {
			await sleep(WAIT_POLL_MS)
			const waited = await this.readCache(key)
			if (waited !== undefined) {
				return waited
			}
		}
		throw new Error(`cache wait timed out for product ${productId}`)
	}

	/** Rebuilds the card from Postgres, overwriting whatever is cached. */
	async refresh(productId: string): Promise<void> {
		const card = await this.repository.load(productId)
		await this.writeCache(productCardKey(productId), card)
	}

	hotProductIds(limit: number): Promise<string[]> {
		return this.repository.hotProductIds(limit)
	}

	private async readCache(
		key: string,
	): Promise<ProductCard | null | undefined> {
		const raw = await this.redis.get(key)
		if (raw === null) {
			return undefined
		}
		const parsed = JSON.parse(raw) as CachedProductCard
		return parsed.found ? parsed.card : null
	}

	/**
	 * A failed cache write must not fail the read. allkeys-lru should evict
	 * instead of OOM; if the policy is wrong, Redis throws on SET.
	 */
	private async writeCache(
		key: string,
		card: ProductCard | null,
	): Promise<void> {
		const payload: CachedProductCard = card
			? { found: true, card }
			: { found: false, card: null }
		try {
			await this.redis.set(
				key,
				JSON.stringify(payload),
				'EX',
				cacheTtlSeconds(),
			)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			console.error(`cache set failed: ${message}`)
		}
	}
}
