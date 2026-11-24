import { Module } from '@nestjs/common'
import { OrdersModule } from '../orders/orders.module'
import { OrderMessagingService } from './order-messaging.service'

@Module({
	imports: [OrdersModule],
	providers: [OrderMessagingService],
})
export class MessagingModule {}
