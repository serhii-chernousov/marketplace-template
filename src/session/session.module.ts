import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import type Redis from 'ioredis'
import { QUEUE_REDIS } from '../redis/redis.module'
import { SessionStore } from './session-store'
import { SessionGuard } from './session.guard'
import { SessionMiddleware } from './session.middleware'
import { SessionsController } from './sessions.controller'

const SESSION_TTL_SEC = 30 * 60

@Module({
	controllers: [SessionsController],
	providers: [
		{
			provide: SessionStore,
			inject: [QUEUE_REDIS],
			useFactory: (redis: Redis) => new SessionStore(redis, SESSION_TTL_SEC),
		},
		SessionMiddleware,
		SessionGuard,
	],
	exports: [SessionStore, SessionGuard],
})
export class SessionModule implements NestModule {
	configure(consumer: MiddlewareConsumer) {
		consumer.apply(SessionMiddleware).forRoutes('*')
	}
}
