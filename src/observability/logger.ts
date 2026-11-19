import { trace } from '@opentelemetry/api'
import pino, { type DestinationStream, type LoggerOptions } from 'pino'
import { requestContext } from './request-context'

/**
 * pino redacts only the exact paths listed: `*.password` covers one level of
 * nesting, so `{ user: { credentials: { password } } }` would leak. Request
 * bodies are never logged at all; these paths guard headers and the shapes
 * the code actually logs.
 */
export const REDACT_PATHS = [
	'req.headers.authorization',
	'req.headers.cookie',
	'req.headers["x-session-id"]',
	'res.headers["set-cookie"]',
	'req.body.password',
	'req.body.refresh_token',
	'*.password',
	'*.access_token',
	'*.refresh_token',
	'*.authorization',
]

export const loggerOptions: LoggerOptions = {
	level: process.env.LOG_LEVEL ?? 'info',
	base: { service: process.env.OTEL_SERVICE_NAME ?? 'marketplace-api' },
	timestamp: pino.stdTimeFunctions.isoTime,
	redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
	mixin() {
		const span = trace.getActiveSpan()?.spanContext()
		const ctx = requestContext.getStore()
		return {
			trace_id: span?.traceId,
			span_id: span?.spanId,
			userId: ctx?.userId,
			tenant: ctx?.tenant,
			idempotencyKey: ctx?.idempotencyKey,
		}
	},
}

export function createLogger(destination?: DestinationStream): pino.Logger {
	return destination ? pino(loggerOptions, destination) : pino(loggerOptions)
}

export const logger = createLogger()
