import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { WorkerModule } from './queue/worker.module'

async function bootstrap() {
	const app = await NestFactory.createApplicationContext(WorkerModule)
	app.enableShutdownHooks()
}

bootstrap().catch((err: unknown) => {
	console.error(err)
	process.exit(1)
})
