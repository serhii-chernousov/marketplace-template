import {
	MiddlewareConsumer,
	Module,
	NestModule,
	RequestMethod,
} from '@nestjs/common'
import * as OpenApiValidator from 'express-openapi-validator'
import { join } from 'path'
import { StoreService } from './services/store.service'
import { ConfigModule } from '@nestjs/config'
import { validate } from './config/env.schema'
import { ListingsController } from './controllers/listings.controller'
import { OrdersController } from './controllers/orders.controller'
import { HealthController } from './controllers/health.controller'
import { DbService } from './services/db.service'

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
			validate,
			envFilePath: '.env',
		}),
	],
	providers: [StoreService, DbService],
	controllers: [ListingsController, OrdersController, HealthController],
})
export class AppModule implements NestModule {
	configure(consumer: MiddlewareConsumer) {
		consumer
			.apply(
				...OpenApiValidator.middleware({
					apiSpec: join(process.cwd(), 'openapi', 'openapi.yaml'),
					validateRequests: true,
					validateResponses: true,
				}),
			)
			.exclude(
				{ path: 'health', method: RequestMethod.GET },
				{ path: 'db', method: RequestMethod.GET },
			)
			.forRoutes('*')
	}
}
