import {
	ArgumentsHost,
	Catch,
	ExceptionFilter,
	HttpException,
} from '@nestjs/common'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { Request, Response } from 'express'
import { logger } from '../observability/logger'
import { ProblemException } from '../types/problem.exception'

const log = logger.child({ layer: 'http.errors' })

@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
	catch(exception: unknown, host: ArgumentsHost) {
		const ctx = host.switchToHttp()
		const res = ctx.getResponse<Response>()
		const req = ctx.getRequest<Request>()

		if (exception instanceof ProblemException) {
			if (exception.status >= 500) {
				recordServerError(exception)
			}
			return res
				.status(exception.status)
				.type('application/problem+json')
				.json(exception.body)
		}

		if (exception instanceof HttpException) {
			const status = exception.getStatus()
			if (status >= 500) {
				recordServerError(exception)
			}
			const payload = exception.getResponse()
			const detail =
				typeof payload === 'string'
					? payload
					: (payload as { message?: string | string[] }).message
			return res
				.status(status)
				.type('application/problem+json')
				.json({
					type: `https://marketplace.local/problems/http-${status}`,
					title: status >= 500 ? 'Internal Server Error' : 'Request Error',
					status,
					detail: Array.isArray(detail)
						? detail.join('; ')
						: detail || exception.message,
					instance: req.originalUrl,
				})
		}

		const err = exception as {
			status?: number
			statusCode?: number
			message?: string
		}
		const status = err.status || err.statusCode || 500
		const detail = err.message || 'Unexpected error'
		if (status >= 500) {
			recordServerError(exception)
		}

		return res
			.status(status)
			.type('application/problem+json')
			.json({
				type: `https://marketplace.local/problems/http-${status}`,
				title: status >= 500 ? 'Internal Server Error' : 'Request Error',
				status,
				detail,
				instance: req.originalUrl,
			})
	}
}

/** Without this a 5xx leaves no log line and a span with no exception to read. */
function recordServerError(exception: unknown): void {
	const error =
		exception instanceof Error ? exception : new Error(String(exception))
	const span = trace.getActiveSpan()
	span?.recordException(error)
	span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
	log.error({ err: error }, 'request failed')
}
