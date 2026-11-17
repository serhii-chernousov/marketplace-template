/**
 * Reads values that come from the vault wrapper (scripts/with-secrets.sh).
 * Runs before anything touches the cluster, so a missing value fails the
 * preview with its own name instead of an unrelated API error.
 */
export function requireEnv<const N extends string>(
	names: readonly N[],
): Record<N, string> {
	const missing = names.filter((name) => !process.env[name])
	if (missing.length > 0) {
		throw new Error(
			`missing required env: ${missing.join(', ')} (run through scripts/with-secrets.sh or export them)`,
		)
	}
	return Object.fromEntries(
		names.map((name) => [name, process.env[name] as string]),
	) as Record<N, string>
}
