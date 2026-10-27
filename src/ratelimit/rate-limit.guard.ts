import {
	CanActivate,
	ExecutionContext,
	Injectable,
	Logger,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Response } from 'express'
import { ProblemException } from '../types/problem.exception'
import type { SessionRequest } from '../session/session.middleware'
import { RateLimit } from './rate-limit.decorator'
import {
	SlidingWindowLimiter,
	type LimitResponse,
} from './sliding-window-limiter'

/**
 * Applies to handlers marked with @RateLimit. The counter lives in Redis,
 * so every pod spends the same budget.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
	private readonly logger = new Logger(RateLimitGuard.name)

	constructor(
		private readonly reflector: Reflector,
		private readonly limiter: SlidingWindowLimiter,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const policy = this.reflector.get(RateLimit, context.getHandler())
		if (!policy) {
			return true
		}
		const req = context.switchToHttp().getRequest<SessionRequest>()
		const route = `${context.getClass().name}.${context.getHandler().name}`
		const bucket = `${route}:${clientKey(req)}`

		let response: LimitResponse
		try {
			response = await this.limiter.consume(bucket, policy)
		} catch (err) {
			// Fail open: a Redis outage must not take the API down with it.
			const message = err instanceof Error ? err.message : String(err)
			this.logger.warn(`rate-limit skipped: ${message}`)
			return true
		}
		if (response.allowed) {
			return true
		}

		const res = context.switchToHttp().getResponse<Response>()
		for (const [name, value] of Object.entries(response.headers)) {
			res.setHeader(name, value)
		}
		throw new ProblemException(
			429,
			'https://marketplace.local/problems/rate-limited',
			'Too many requests',
			`Limit is ${policy.limit} requests per ${policy.windowMs / 1000}s`,
			req.originalUrl,
		)
	}
}

function clientKey(req: SessionRequest): string {
	const userId = req.header('x-user-id') ?? req.activeSession?.userId
	return userId ? `user:${userId}` : `ip:${req.ip}`
}
