import {
	Global,
	type INestApplicationContext,
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

const REDIS_CONNECT_TIMEOUT_MS = 1000
const REDIS_COMMAND_TIMEOUT_MS = 500

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
			const client = new Redis(config.get(variable, { infer: true }), {
				lazyConnect: true,
				maxRetriesPerRequest: 2,
				// Fail fast while disconnected: queued commands would wait out the
				// reconnect, and one request makes several sequential Redis calls.
				enableOfflineQueue: false,
				connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
				commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
			})
			const logger = new Logger(variable)
			client.on('error', (err: Error) => logger.warn(err.message))
			return client
		},
	}
}

/**
 * Clients are lazy so tests can boot without Redis; long-running processes
 * connect up front because the offline queue is off. A Redis that is down at
 * boot is not fatal: ioredis keeps reconnecting and callers fail open meanwhile.
 */
export async function connectRedisClients(
	app: INestApplicationContext,
): Promise<void> {
	const logger = new Logger('RedisModule')
	await Promise.all(
		[CACHE_REDIS, QUEUE_REDIS].map((token) =>
			app
				.get<Redis>(token)
				.connect()
				.catch((err: unknown) =>
					logger.warn(
						`initial connect failed: ${err instanceof Error ? err.message : String(err)}`,
					),
				),
		),
	)
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
