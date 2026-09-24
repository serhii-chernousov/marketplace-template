import { Module } from '@nestjs/common'
import { DbService } from '../database/db.service'
import { HealthController } from './health.controller'

@Module({
	controllers: [HealthController],
	providers: [DbService],
})
export class HealthModule {}
