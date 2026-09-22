import { Logger } from 'typeorm'

/**
 * Counts every SQL query TypeORM sends. N+1 is invisible in JS — only in the log.
 */
export class QueryCountLogger implements Logger {
	count = 0

	reset(): void {
		this.count = 0
	}

	logQuery(query: string): void {
		this.count += 1
		console.log(`sql[${this.count}] ${query}`)
	}

	logQueryError(): void {}

	logQuerySlow(): void {}

	logSchemaBuild(): void {}

	logMigration(): void {}

	log(): void {}
}
