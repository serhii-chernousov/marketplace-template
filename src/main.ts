import { shutdownTelemetry } from './observability/otel'
import 'reflect-metadata'
import type { Server } from 'http'
import { NestFactory } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { AppModule } from './app.module'
import { configureApp } from './configure-app'
import { Env } from './config/env.schema'
import { sleep } from './common/sleep'
import { assertSchemaUpToDate } from './database/schema-check'
import { ReadinessState } from './health/readiness'
import { connectRedisClients } from './redis/redis.module'
import { logger } from './observability/logger'
import { PinoNestLogger } from './observability/nest-logger'

async function bootstrap() {
	const app = await NestFactory.create(AppModule, { bufferLogs: true })
	app.useLogger(new PinoNestLogger())
	configureApp(app)
	const config = app.get(ConfigService<Env, true>)
	const readiness = app.get(ReadinessState)

	await assertSchemaUpToDate()
	await connectRedisClients(app)
	await sleep(config.get('WARMUP_MS', { infer: true }))

	const port = config.get('PORT', { infer: true })
	await app.listen(port)
	readiness.markReady()
	logger.info({ port }, 'marketplace api listening')

	process.once('SIGTERM', () => {
		void (async () => {
			// Stop advertising readiness first; closing the socket while the
			// Service still routes here turns in-flight traffic into errors.
			readiness.markNotReady()
			await sleep(config.get('DRAIN_MS', { infer: true }))
			const server = app.getHttpServer() as Server
			// SSE and socket.io keep connections open forever; app.close() would wait for SIGKILL.
			setTimeout(
				() => server.closeAllConnections(),
				config.get('SHUTDOWN_TIMEOUT_MS', { infer: true }),
			).unref()
			await app.close()
			await shutdownTelemetry()
			process.exit(0)
		})()
	})
}

bootstrap().catch((err: unknown) => {
	logger.fatal({ err }, 'bootstrap failed')
	process.exit(1)
})
