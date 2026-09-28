import {
	MiddlewareConsumer,
	Module,
	NestModule,
	RequestMethod,
} from '@nestjs/common'
import * as OpenApiValidator from 'express-openapi-validator'
import { join } from 'path'
import { ConfigModule } from '@nestjs/config'
import { validate } from './config/env.schema'
import { CheckoutModule } from './checkout/checkout.module'
import { DatabaseModule } from './database/database.module'
import { HealthModule } from './health/health.module'
import { JobsModule } from './jobs/jobs.module'
import { ListingsModule } from './listings/listings.module'
import { OrdersModule } from './orders/orders.module'
import { StoreModule } from './store/store.module'

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
			validate,
			envFilePath: '.env',
		}),
		DatabaseModule,
		StoreModule,
		CheckoutModule,
		JobsModule,
		ListingsModule,
		OrdersModule,
		HealthModule,
	],
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
