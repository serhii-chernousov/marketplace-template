import { Controller, Get, Header } from '@nestjs/common'
import { Public } from '../auth/decorators'
import { registry } from './metrics'

@Public()
@Controller()
export class MetricsController {
	@Get('metrics')
	@Header('Content-Type', registry.contentType)
	scrape(): Promise<string> {
		return registry.metrics()
	}
}
