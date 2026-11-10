import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { randomBytes } from 'node:crypto'
import { DataSource } from 'typeorm'
import { hashPassword } from '../auth/password'
import type { UserRole } from '../entities/user.entity'

export interface DemoApp {
	app: INestApplication
	dataSource: DataSource
	call: (
		method: string,
		path: string,
		options?: { token?: string; body?: unknown },
	) => Promise<{ status: number; body: Record<string, unknown> }>
}

export interface DemoAccount {
	id: string
	email: string
	password: string
}

/**
 * The app runs inside the demo process, so it cannot outlive it: no orphan
 * server holding the port after a timeout kill. PORT is set before AppModule
 * is loaded because ConfigModule validates the environment at import time.
 */
export async function startDemoApp(port: number): Promise<DemoApp> {
	setTimeout(() => {
		console.error('demo timed out')
		process.exit(1)
	}, 60_000).unref()

	process.env.PORT = String(port)
	const { AppModule } = await import('../app.module')
	const { configureApp } = await import('../configure-app')
	const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] })
	configureApp(app)
	await app.listen(port, '127.0.0.1')

	const baseUrl = `http://127.0.0.1:${port}`
	return {
		app,
		dataSource: app.get(DataSource),
		call: async (method, path, { token, body } = {}) => {
			const res = await fetch(`${baseUrl}${path}`, {
				method,
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			})
			const text = await res.text()
			return { status: res.status, body: text ? JSON.parse(text) : {} }
		},
	}
}

/** Upserts the demo's own accounts with fresh random passwords and wipes only their data. */
export async function resetDemoAccounts(
	dataSource: DataSource,
	accounts: Array<{ email: string; role: UserRole }>,
): Promise<DemoAccount[]> {
	const prepared: DemoAccount[] = []
	for (const { email, role } of accounts) {
		const password = randomBytes(18).toString('base64url')
		const rows: Array<{ id: string }> = await dataSource.query(
			`INSERT INTO users (email, full_name, role, password_hash, is_active)
			 VALUES ($1, $2, $3, $4, true)
			 ON CONFLICT (email) DO UPDATE
			   SET role = EXCLUDED.role,
			       password_hash = EXCLUDED.password_hash,
			       is_active = true
			 RETURNING id`,
			[email, `Demo ${role}`, role, await hashPassword(password)],
		)
		prepared.push({ id: String(rows[0].id), email, password })
	}
	const ids = prepared.map((account) => account.id)
	await dataSource.query(`DELETE FROM orders WHERE user_id = ANY($1)`, [ids])
	await dataSource.query(`DELETE FROM products WHERE seller_id = ANY($1)`, [
		ids,
	])
	await dataSource.query(`DELETE FROM refresh_tokens WHERE user_id = ANY($1)`, [
		ids,
	])
	return prepared
}

/** Prints what differs and returns whether every metric hit one of its allowed values. */
export function meetsExpectations(
	metrics: Record<string, number>,
	expected: Record<string, number[]>,
): boolean {
	const misses = Object.entries(expected).filter(
		([key, allowed]) => !allowed.includes(metrics[key]),
	)
	for (const [key, allowed] of misses) {
		console.error(
			`invariant broken: ${key}=${metrics[key]} (expected ${allowed.join(' or ')})`,
		)
	}
	return misses.length === 0
}

export async function runDemo(body: () => Promise<number>): Promise<void> {
	let exitCode = 1
	try {
		exitCode = await body()
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err))
	}
	process.exit(exitCode)
}
