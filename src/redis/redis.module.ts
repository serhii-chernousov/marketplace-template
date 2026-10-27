import {
	Global,
	Inject,
	Injectable,
	Logger,
	Module,
	OnModuleDestroy,
	type FactoryProvider,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'
import type { Env } from '../config/env.schema'

/** maxmemory + allkeys-lru: anything here may vanish. */
export const CACHE_REDIS = Symbol('CACHE_REDIS')
/** noeviction: sessions and rate-limit counters. */
export const QUEUE_REDIS = Symbol('QUEUE_REDIS')

@Injectable()
class RedisShutdown implements OnModuleDestroy {
	constructor(
		@Inject(CACHE_REDIS) private readonly cache: Redis,
		@Inject(QUEUE_REDIS) private readonly queue: Redis,
	) {}

	onModuleDestroy(): void {
		this.cache.disconnect()
		this.queue.disconnect()
	}
}

/**
 * lazyConnect: the app boots without Redis (e2e, contract tests) and
 * connects on the first command.
 */
function redisClient(
	token: symbol,
	variable: 'REDIS_URL' | 'REDIS_QUEUE_URL',
): FactoryProvider<Redis> {
	return {
		provide: token,
		inject: [ConfigService],
		useFactory: (config: ConfigService<Env, true>): Redis => {
			const url = config.get(variable, { infer: true })
			if (!url) {
				throw new Error(`${variable} is required`)
			}
			const client = new Redis(url, {
				lazyConnect: true,
				maxRetriesPerRequest: 2,
			})
			const logger = new Logger(variable)
			client.on('error', (err: Error) => logger.warn(err.message))
			return client
		},
	}
}

@Global()
@Module({
	providers: [
		redisClient(CACHE_REDIS, 'REDIS_URL'),
		redisClient(QUEUE_REDIS, 'REDIS_QUEUE_URL'),
		RedisShutdown,
	],
	exports: [CACHE_REDIS, QUEUE_REDIS],
})
export class RedisModule {}
