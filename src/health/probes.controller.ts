import { Controller, Get, HttpStatus, Res } from '@nestjs/common'
import type { Response } from 'express'
import { Public } from '../auth/decorators'
import { ReadinessState } from './readiness'

@Public()
@Controller()
export class ProbesController {
	constructor(private readonly readiness: ReadinessState) {}

	@Get('healthz')
	liveness() {
		return { status: 'alive' }
	}

	@Get('readyz')
	readinessProbe(@Res({ passthrough: true }) res: Response) {
		if (!this.readiness.isReady()) {
			res.status(HttpStatus.SERVICE_UNAVAILABLE)
			return { status: 'not-ready' }
		}
		return { status: 'ready' }
	}
}
