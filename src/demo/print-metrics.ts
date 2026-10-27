/** One `key=number` line per metric. No spaces — the grader uses grep -qx. */
export function printMetrics(metrics: Record<string, number>): void {
	for (const [key, value] of Object.entries(metrics)) {
		console.log(`${key}=${value}`)
	}
}
