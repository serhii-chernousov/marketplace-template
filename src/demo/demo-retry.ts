import { DataSource } from 'typeorm'
import { asRows } from '../common/pg-rows'
import { readPgCode, withRetry } from '../common/with-retry'
import base from '../database/data-source'

/**
 * Barrier so both REPEATABLE READ transactions SELECT before either UPDATE.
 * Only the first attempt waits; retries must not re-arm the barrier.
 */
function createBarrier(parties: number): {
	waitFirstPass: () => Promise<void>
} {
	let arrived = 0
	let resolveReady: (() => void) | undefined
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve
	})
	let firstPassDone = false

	return {
		async waitFirstPass(): Promise<void> {
			if (firstPassDone) {
				return
			}
			arrived += 1
			if (arrived >= parties) {
				firstPassDone = true
				resolveReady?.()
			}
			await ready
		},
	}
}

async function main(): Promise<void> {
	const ds = new DataSource({
		...base.options,
	})
	await ds.initialize()

	try {
		await ds.query(
			`UPDATE concurrency_probe SET value = 0 WHERE id = 1`,
		)

		const barrier = createBarrier(2)
		let caughtCode: string | undefined
		let retryCount = 0

		const originalLog = console.log
		console.log = (...args: unknown[]) => {
			const line = args.map(String).join(' ')
			if (line.includes('retry attempt=')) {
				retryCount += 1
				const match = line.match(/code=(\w+)/)
				if (match) {
					caughtCode = match[1]
				}
			}
			originalLog(...args)
		}

		try {
			await Promise.all([
				withRetry(() =>
					ds.transaction('REPEATABLE READ', async (manager) => {
						const rows = asRows<{ value: number }>(
							await manager.query(
								`SELECT value FROM concurrency_probe WHERE id = 1`,
							),
						)
						const current = Number(rows[0].value)
						await barrier.waitFirstPass()
						await manager.query(
							`UPDATE concurrency_probe SET value = $1 WHERE id = 1`,
							[current + 1],
						)
					}),
				),
				withRetry(() =>
					ds.transaction('REPEATABLE READ', async (manager) => {
						const rows = asRows<{ value: number }>(
							await manager.query(
								`SELECT value FROM concurrency_probe WHERE id = 1`,
							),
						)
						const current = Number(rows[0].value)
						await barrier.waitFirstPass()
						await manager.query(
							`UPDATE concurrency_probe SET value = $1 WHERE id = 1`,
							[current + 1],
						)
					}),
				),
			])
		} finally {
			console.log = originalLog
		}

		const finalRows = asRows<{ value: number }>(
			await ds.query(
				`SELECT value FROM concurrency_probe WHERE id = 1`,
			),
		)
		const finalValue = Number(finalRows[0].value)

		console.log(
			`caught: ${caughtCode ?? 'none'} (40001|40P01 expected)`,
		)
		console.log(`retry count: ${retryCount}`)
		console.log(`final value: ${finalValue}`)

		const okCode =
			caughtCode === '40001' || caughtCode === '40P01'
		if (!okCode || retryCount < 1 || finalValue !== 2) {
			if (!caughtCode) {
				console.error(
					'expected at least one serialization/deadlock retry',
					{ caughtCode, retryCount, finalValue },
				)
			}
			process.exitCode = 1
		}
	} finally {
		await ds.destroy()
	}
}

main().catch((err: unknown) => {
	const code = readPgCode(err)
	console.error(err)
	if (code) {
		console.error(`pg code: ${code}`)
	}
	process.exitCode = 1
})
