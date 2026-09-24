import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'
import type { Env } from '../config/env.schema'

/**
 * Lightweight pg.Pool for /db health (ДЗ #11 password-file pattern).
 * Domain transactions use TypeORM DataSource from DatabaseModule.
 */
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
			password: async () => {
				try {
					return (await readFile(passwordFile, 'utf8')).trimEnd()
				} catch {
					return config.get('DB_PASSWORD', { infer: true })
				}
			},
		})

		this.pool.on('error', (err) => {
			console.error(err.message)
		})
	}

	async ping() {
		await this.pool.query('SELECT 1')
	}

	async onModuleDestroy() {
		await this.pool.end()
	}
}
