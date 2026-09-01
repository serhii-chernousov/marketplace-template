import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { ProblemExceptionFilter } from './problem-exception.filter'

async function bootstrap() {
	const app = await NestFactory.create(AppModule)
	app.useGlobalFilters(new ProblemExceptionFilter())
	const port = process.env.PORT || 3000
	await app.listen(port)
	console.log(`Marketplace API listening on http://localhost:${port}`)
}

bootstrap()
