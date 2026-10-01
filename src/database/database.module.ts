import {
	Global,
	Injectable,
	Module,
	OnModuleDestroy,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DataSource } from 'typeorm'
import type { Env } from '../config/env.schema'
import { TYPEORM_ENTITIES } from './typeorm-entities'

export { TYPEORM_ENTITIES } from './typeorm-entities'

@Injectable()
class DataSourceShutdown implements OnModuleDestroy {
	constructor(private readonly dataSource: DataSource) {}

	async onModuleDestroy(): Promise<void> {
		if (this.dataSource.isInitialized) {
			await this.dataSource.destroy()
		}
	}
}

@Global()
@Module({
	providers: [
		{
			provide: DataSource,
			inject: [ConfigService],
			useFactory: async (
				config: ConfigService<Env, true>,
			): Promise<DataSource> => {
				const dataSource = new DataSource({
					type: 'postgres',
					host: config.get('DB_HOST', { infer: true }),
					port: config.get('DB_PORT', { infer: true }),
					username: config.get('DB_USER', { infer: true }),
					password: config.get('DB_PASSWORD', { infer: true }),
					database: config.get('DB_NAME', { infer: true }),
					synchronize: false,
					logging: false,
					entities: TYPEORM_ENTITIES,
				})
				await dataSource.initialize()
				return dataSource
			},
		},
		DataSourceShutdown,
	],
	exports: [DataSource],
})
export class DatabaseModule {}
