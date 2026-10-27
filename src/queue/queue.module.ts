import { Module } from '@nestjs/common'
import { RatingQueueService } from './rating-queue.service'

@Module({
	providers: [RatingQueueService],
	exports: [RatingQueueService],
})
export class QueueModule {}
