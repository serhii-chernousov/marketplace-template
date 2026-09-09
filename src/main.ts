import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { ProblemExceptionFilter } from './filters/problem-exception.filter'
import { Env } from './config/env.schema'
import { ConfigService } from '@nestjs/config'

async function bootstrap() {
	const app = await NestFactory.create(AppModule)
	app.useGlobalFilters(new ProblemExceptionFilter())
	const configService = app.get(ConfigService<Env, true>)
	const port = configService.get('PORT', { infer: true })
	await app.listen(port)
	console.log(`Marketplace API listening on http://localhost:${port}`)
}

bootstrap().catch((err: unknown) => {
	console.error(err)
	process.exit(1)
})
