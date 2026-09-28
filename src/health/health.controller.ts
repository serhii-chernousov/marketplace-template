import { Controller, Get } from '@nestjs/common'
import { DbService } from '../database/db.service'

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
