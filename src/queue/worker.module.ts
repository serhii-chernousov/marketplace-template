import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { CatalogModule } from '../catalog/catalog.module'
import { validateWorkerEnv } from '../config/env.schema'
import { DatabaseModule } from '../database/database.module'
import { RedisModule } from '../redis/redis.module'
import { RatingWorker } from './rating.worker'

/** Worker process: no HTTP, only the queue consumer and its scheduler. */
@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
			validate: validateWorkerEnv,
			envFilePath: '.env',
		}),
		DatabaseModule,
		RedisModule,
		CatalogModule,
	],
	providers: [RatingWorker],
})
export class WorkerModule {}
