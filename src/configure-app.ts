import type { INestApplication } from '@nestjs/common'
import { ProblemExceptionFilter } from './filters/problem-exception.filter'

/**
 * Shared Nest bootstrap wiring so E2E / provider tests match production.
 */
export function configureApp(app: INestApplication): void {
	app.useGlobalFilters(new ProblemExceptionFilter())
}
