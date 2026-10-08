import { Module } from '@nestjs/common'
import { CheckoutModule } from '../checkout/checkout.module'
import { OrderEventsController } from './order-events.controller'
import { OrderEventsService } from './order-events.service'
import { OrdersController } from './orders.controller'
import { OrdersGateway } from './orders.gateway'
import { OrdersService } from './orders.service'

@Module({
	imports: [CheckoutModule],
	controllers: [OrdersController, OrderEventsController],
	providers: [OrdersService, OrderEventsService, OrdersGateway],
	exports: [OrdersService, OrderEventsService],
})
export class OrdersModule {}
