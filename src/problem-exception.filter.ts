import {
	ArgumentsHost,
	Catch,
	ExceptionFilter,
	HttpException,
} from '@nestjs/common'
import { Request, Response } from 'express'
import { ProblemException } from './problem.exception'

@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
	catch(exception: unknown, host: ArgumentsHost) {
		const ctx = host.switchToHttp()
		const res = ctx.getResponse<Response>()
		const req = ctx.getRequest<Request>()

		if (exception instanceof ProblemException) {
			return res
				.status(exception.status)
				.type('application/problem+json')
				.json(exception.body)
		}

		if (exception instanceof HttpException) {
			const status = exception.getStatus()
			const payload = exception.getResponse()
			const detail =
				typeof payload === 'string'
					? payload
					: (payload as { message?: string | string[] }).message
			return res.status(status).type('application/problem+json').json({
				type: `https://marketplace.local/problems/http-${status}`,
				title: status >= 500 ? 'Internal Server Error' : 'Request Error',
				status,
				detail: Array.isArray(detail) ? detail.join('; ') : detail || exception.message,
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

		return res.status(status).type('application/problem+json').json({
			type: `https://marketplace.local/problems/http-${status}`,
			title: status >= 500 ? 'Internal Server Error' : 'Request Error',
			status,
			detail,
			instance: req.originalUrl,
		})
	}
}
