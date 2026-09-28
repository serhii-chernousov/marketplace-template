/**
 * TypeORM's Postgres driver may return either `rows` or `[rows, rowCount]`
 * from `query()`. Normalize to a row array.
 */
export function asRows<T>(result: unknown): T[] {
	if (!Array.isArray(result)) {
		return []
	}
	if (
		result.length === 2 &&
		Array.isArray(result[0]) &&
		typeof result[1] === 'number'
	) {
		return result[0] as T[]
	}
	return result as T[]
}
