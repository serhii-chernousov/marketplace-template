import { Controller, Get } from '@nestjs/common'
import { Public } from '../auth/decorators'
import { DbService } from '../database/db.service'

@Public()
@Controller()
export class HealthController {
	constructor(private readonly db: DbService) {}

	@Get('health')
	health() {
		return { uptime: process.uptime() }
	}

	@Get('db')
	async dbHealth() {
		await this.db.ping()
		return { ok: true }
	}
}
