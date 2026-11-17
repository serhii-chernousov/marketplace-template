import {
	Global,
	Inject,
	Injectable,
	Module,
	OnModuleDestroy,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { S3Client } from '@aws-sdk/client-s3'
import type { ApiEnv } from '../config/env.schema'
import { createS3Client } from './s3-client'

export const S3_CLIENT = Symbol('S3_CLIENT')
export const STORAGE_BUCKET = Symbol('STORAGE_BUCKET')

@Injectable()
class S3Shutdown implements OnModuleDestroy {
	constructor(@Inject(S3_CLIENT) private readonly s3: S3Client) {}

	onModuleDestroy(): void {
		this.s3.destroy()
	}
}

@Global()
@Module({
	providers: [
		{
			provide: S3_CLIENT,
			inject: [ConfigService],
			useFactory: (config: ConfigService<ApiEnv, true>): S3Client =>
				createS3Client({
					STORAGE_ENDPOINT: config.get('STORAGE_ENDPOINT', { infer: true }),
					STORAGE_REGION: config.get('STORAGE_REGION', { infer: true }),
					STORAGE_ACCESS_KEY: config.get('STORAGE_ACCESS_KEY', { infer: true }),
					STORAGE_SECRET_KEY: config.get('STORAGE_SECRET_KEY', { infer: true }),
					STORAGE_BUCKET: config.get('STORAGE_BUCKET', { infer: true }),
				}),
		},
		{
			provide: STORAGE_BUCKET,
			inject: [ConfigService],
			useFactory: (config: ConfigService<ApiEnv, true>): string =>
				config.get('STORAGE_BUCKET', { infer: true }),
		},
		S3Shutdown,
	],
	exports: [S3_CLIENT, STORAGE_BUCKET],
})
export class StorageModule {}
