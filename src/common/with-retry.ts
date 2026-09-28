const RETRYABLE = new Set(['40001', '40P01'])

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Read PostgreSQL SQLSTATE from a TypeORM or node-pg error.
 */
export function readPgCode(err: unknown): string | undefined {
	if (!err || typeof err !== 'object') {
		return undefined
	}
	const asRecord = err as {
		code?: unknown
		driverError?: { code?: unknown }
	}
	if (typeof asRecord.code === 'string') {
		return asRecord.code
	}
	if (typeof asRecord.driverError?.code === 'string') {
		return asRecord.driverError.code
	}
	return undefined
}

/**
 * Retry the whole transaction callback on serialization_failure (40001)
 * or deadlock_detected (40P01) only. Other codes are rethrown immediately.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	maxAttempts = 5,
): Promise<T> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn()
		} catch (err: unknown) {
			const code = readPgCode(err)
			const canRetry =
				code !== undefined &&
				RETRYABLE.has(code) &&
				attempt < maxAttempts
			if (!canRetry) {
				throw err
			}
			const waitMs = 10 * 2 ** (attempt - 1)
			console.log(
				`retry attempt=${attempt} code=${code} backoffMs=${waitMs}`,
			)
			await delay(waitMs)
		}
	}
	throw new Error('unreachable')
}
