import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import type Redis from 'ioredis'
import { QUEUE_REDIS } from '../redis/redis.module'
import { RateLimitGuard } from './rate-limit.guard'
import { SlidingWindowLimiter } from './sliding-window-limiter'

@Module({
	providers: [
		{
			provide: SlidingWindowLimiter,
			inject: [QUEUE_REDIS],
			useFactory: (redis: Redis) => new SlidingWindowLimiter(redis),
		},
		{ provide: APP_GUARD, useClass: RateLimitGuard },
	],
})
export class RateLimitModule {}
