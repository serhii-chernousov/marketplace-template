import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { WorkerModule } from './queue/worker.module'
import { connectRedisClients } from './redis/redis.module'

async function bootstrap() {
	const app = await NestFactory.createApplicationContext(WorkerModule)
	app.enableShutdownHooks()
	await connectRedisClients(app)
}

bootstrap().catch((err: unknown) => {
	console.error(err)
	process.exit(1)
})
