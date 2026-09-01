import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import * as OpenApiValidator from 'express-openapi-validator'
import { join } from 'path'
import { ListingsController } from './listings.controller'
import { OrdersController } from './orders.controller'
import { StoreService } from './store.service'

@Module({
	controllers: [ListingsController, OrdersController],
	providers: [StoreService],
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
			.forRoutes('*')
	}
}
