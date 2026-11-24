import type { NextFunction, Request, Response } from 'express'
import { logger } from './logger'
import { httpDuration, httpRequests } from './metrics'
import { requestContext } from './request-context'

const httpLog = logger.child({ layer: 'http' })

/**
 * A template, never the raw path: raw ids would mint a new series per id.
 * req.route exists once a handler matched; responses the OpenAPI validator
 * sends earlier (400/401/405) still carry its spec template. Both sets are
 * bounded by the code and the spec.
 */
function routeTemplate(req: Request): string {
	const route = req.route as { path?: unknown } | undefined
	if (typeof route?.path === 'string') {
		return `${req.baseUrl}${route.path}`
	}
	const openapi = (req as { openapi?: { openApiRoute?: unknown } }).openapi
	return typeof openapi?.openApiRoute === 'string'
		? openapi.openApiRoute
		: 'unmatched'
}

/**
 * Plain Express middleware, registered before Nest's own pipeline, so guards
 * (401/403/429) and the OpenAPI validator (400) are measured too — an
 * interceptor would never see those responses.
 */
export function httpObservability(
	req: Request,
	res: Response,
	next: NextFunction,
): void {
	const startedAt = process.hrtime.bigint()
	res.once('finish', () => {
		const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9
		const labels = {
			method: req.method,
			route: routeTemplate(req),
			status: String(res.statusCode),
		}
		httpRequests.inc(labels)
		httpDuration.observe(labels, seconds)
		if (labels.route === '/metrics') {
			return
		}
		httpLog.info(
			{
				req: { method: req.method, url: req.originalUrl, headers: req.headers },
				res: { statusCode: res.statusCode },
				route: labels.route,
				durationMs: Math.round(seconds * 1000),
			},
			'request completed',
		)
	})

	requestContext.run(
		{
			tenant: req.header('x-tenant-id') ?? 'public',
			idempotencyKey: req.header('idempotency-key'),
		},
		next,
	)
}
