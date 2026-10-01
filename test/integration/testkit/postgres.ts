import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { DataSource } from 'typeorm'
import { TYPEORM_ENTITIES } from '../../../src/database/typeorm-entities'
import { InitSchema1790007847172 } from '../../../src/migrations/1790007847172-InitSchema'
import { AddProductsNameUniq1790180000000 } from '../../../src/migrations/1790180000000-AddProductsNameUniq'
import { AddBalanceAndJobQueue1790200000000 } from '../../../src/migrations/1790200000000-AddBalanceAndJobQueue'

let container: StartedPostgreSqlContainer | undefined
let dataSource: DataSource | undefined
let users = 0

/**
 * Maps a Postgres connection URI into the env vars Nest ConfigModule expects.
 * Also sets DATABASE_URL for greppable / lecture-style tooling.
 */
export function applyTestDatabaseEnv(uri: string): void {
	const parsed = new URL(uri)
	process.env.DATABASE_URL = uri
	process.env.DB_HOST = parsed.hostname
	process.env.DB_PORT = parsed.port
	process.env.DB_USER = decodeURIComponent(parsed.username)
	process.env.DB_PASSWORD = decodeURIComponent(parsed.password)
	process.env.DB_NAME = parsed.pathname.replace(/^\//, '')
	process.env.DB_URL = uri
	process.env.PORT = process.env.PORT || '3000'
}

/**
 * Starts one postgres:16-alpine container per Jest process and runs migrations.
 * Shared across integration / e2e / provider files via module cache + user count.
 */
export async function startTestDatabase(): Promise<DataSource> {
	users += 1
	if (dataSource?.isInitialized) {
		return dataSource
	}
	container = await new PostgreSqlContainer('postgres:16-alpine').start()
	const uri = container.getConnectionUri()
	applyTestDatabaseEnv(uri)
	dataSource = new DataSource({
		type: 'postgres',
		url: uri,
		synchronize: false,
		logging: false,
		entities: TYPEORM_ENTITIES,
		migrations: [
			InitSchema1790007847172,
			AddProductsNameUniq1790180000000,
			AddBalanceAndJobQueue1790200000000,
		],
	})
	await dataSource.initialize()
	await dataSource.runMigrations()
	return dataSource
}

/**
 * Clears all mutable tables between tests. Restores concurrency_probe seed row.
 */
export async function truncateAll(ds: DataSource): Promise<void> {
	await ds.query(`
		TRUNCATE TABLE
			order_items,
			orders,
			jobs,
			products,
			categories,
			users,
			concurrency_probe
		RESTART IDENTITY CASCADE
	`)
	await ds.query(
		`INSERT INTO concurrency_probe (id, value) VALUES (1, 0)`,
	)
}

/**
 * Destroys DataSource and stops the container when the last suite releases it.
 */
export async function stopTestDatabase(): Promise<void> {
	users -= 1
	if (users > 0) {
		return
	}
	if (dataSource?.isInitialized) {
		await dataSource.destroy()
	}
	dataSource = undefined
	await container?.stop()
	container = undefined
}
