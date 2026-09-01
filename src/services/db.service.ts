import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'
import type { Env } from '../config/env.schema'

@Injectable()
export class DbService implements OnModuleDestroy {
	readonly pool: Pool

	constructor(config: ConfigService<Env, true>) {
		const passwordFile = join(process.cwd(), 'secrets/db_password')

		this.pool = new Pool({
			host: config.get('DB_HOST', { infer: true }),
			port: config.get('DB_PORT', { infer: true }),
			user: config.get('DB_USER', { infer: true }),
			database: config.get('DB_NAME', { infer: true }),
			password: async () => (await readFile(passwordFile, 'utf8')).trimEnd(),
		})

		this.pool.on('error', (err) => {
			console.error(err)
		})
	}

	async ping() {
		await this.pool.query('SELECT 1')
	}

	async onModuleDestroy() {
		await this.pool.end()
	}
}
