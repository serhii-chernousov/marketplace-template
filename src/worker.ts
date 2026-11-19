import './observability/otel'
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { WorkerModule } from './queue/worker.module'
import { connectRedisClients } from './redis/redis.module'
import { logger } from './observability/logger'
import { PinoNestLogger } from './observability/nest-logger'

async function bootstrap() {
	const app = await NestFactory.createApplicationContext(WorkerModule, {
		bufferLogs: true,
	})
	app.useLogger(new PinoNestLogger())
	app.enableShutdownHooks()
	await connectRedisClients(app)
}

bootstrap().catch((err: unknown) => {
	logger.fatal({ err }, 'worker bootstrap failed')
	process.exit(1)
})
