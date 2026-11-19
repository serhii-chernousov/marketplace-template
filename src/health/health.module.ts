import { Module } from '@nestjs/common'
import { DbService } from '../database/db.service'
import { HealthController } from './health.controller'
import { ProbesController } from './probes.controller'
import { ReadinessState } from './readiness'

@Module({
	controllers: [HealthController, ProbesController],
	providers: [DbService, ReadinessState],
	exports: [ReadinessState],
})
export class HealthModule {}
