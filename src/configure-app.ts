import type { INestApplication } from '@nestjs/common'
import { ProblemExceptionFilter } from './filters/problem-exception.filter'
import { httpObservability } from './observability/http-observability'

/**
 * Shared Nest bootstrap wiring so E2E / provider tests match production.
 */
export function configureApp(app: INestApplication): void {
	app.use(httpObservability)
	app.useGlobalFilters(new ProblemExceptionFilter())
}
