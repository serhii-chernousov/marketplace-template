import migrationSource from './data-source'

/**
 * New code must not serve on an old schema: if the migrate Job did not
 * run, the pod fails to start and the rollout stalls on the old pods.
 */
export async function assertSchemaUpToDate(): Promise<void> {
	await migrationSource.initialize()
	try {
		if (await migrationSource.showMigrations()) {
			throw new Error(
				'database schema is behind the code: pending migrations (run the migrate Job first)',
			)
		}
	} finally {
		await migrationSource.destroy()
	}
}
