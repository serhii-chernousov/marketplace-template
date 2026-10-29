/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

/** Polls until `predicate` is true or `timeoutMs` elapses. */
export async function waitUntil(
	predicate: () => boolean,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('timed out')
		}
		await sleep(50)
	}
}
