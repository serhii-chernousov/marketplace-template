import { DataSource } from 'typeorm'
import { ProductCardRepository } from '../catalog/product-card.repository'
import {
	ProductCardService,
	productCardKey,
	productCardLockKey,
} from '../catalog/product-card.service'
import base from '../database/data-source'
import { printMetrics } from './print-metrics'
import { createRedis, redisConfig, requireRedisUrl } from '../redis/redis'

const WARMED = 60
const CONCURRENT = 20
const WARM_READS = 100
const ID_BASE = 9_000_000_000_000

/**
 * Cache-aside demo.
 * Warms keys with jittered TTL, then sends a burst at one missing key.
 * db-calls is the repository counter, reset around the burst.
 */
async function main(): Promise<void> {
	const redis = createRedis(requireRedisUrl())
	const dataSource = new DataSource({ ...base.options })
	const ids = Array.from({ length: WARMED }, (_, index) =>
		String(ID_BASE + index),
	)
	let exitCode = 1

	try {
		await dataSource.initialize()
		const repository = new ProductCardRepository(dataSource)
		const cards = new ProductCardService(redis, repository)
		const policy = await redisConfig(redis, 'maxmemory-policy')
		const maxmemory = Number(await redisConfig(redis, 'maxmemory'))

		for (const productId of ids) {
			await cards.getCard(productId)
		}
		const ttls = new Set<number>()
		for (const productId of ids) {
			const ttl = await redis.ttl(productCardKey(productId))
			ttls.add(ttl)
		}

		const stampedeId = ids[0]
		await redis.del(productCardKey(stampedeId), productCardLockKey(stampedeId))
		repository.reset()
		await Promise.all(
			Array.from({ length: CONCURRENT }, () => cards.getCard(stampedeId)),
		)
		const dbCalls = repository.dbCalls

		repository.reset()
		for (let read = 0; read < WARM_READS; read += 1) {
			await cards.getCard(stampedeId)
		}

		const metrics = {
			'cache-lru': policy === 'allkeys-lru' ? 1 : 0,
			'cache-maxmemory': maxmemory > 0 ? 1 : 0,
			warmed: ids.length,
			'ttl-distinct': ttls.size,
			concurrent: CONCURRENT,
			'db-calls': dbCalls,
			'db-calls-warm': repository.dbCalls,
		}
		printMetrics(metrics)
		exitCode =
			metrics['cache-lru'] === 1 &&
			metrics['cache-maxmemory'] === 1 &&
			metrics.warmed >= 50 &&
			metrics['ttl-distinct'] >= 5 &&
			metrics.concurrent >= 20 &&
			metrics['db-calls'] === 1 &&
			metrics['db-calls-warm'] === 0
				? 0
				: 1
	} finally {
		await redis.del(
			...ids.flatMap((productId) => [
				productCardKey(productId),
				productCardLockKey(productId),
			]),
		)
		await redis.quit()
		if (dataSource.isInitialized) {
			await dataSource.destroy()
		}
	}

	process.exit(exitCode)
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err)
	console.error(message)
	process.exit(1)
})
