import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { ProblemException } from '../types/problem.exception'
import type { SessionRequest } from './session.middleware'

@Injectable()
export class SessionGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const req = context.switchToHttp().getRequest<SessionRequest>()
		if (!req.activeSession) {
			throw new ProblemException(
				401,
				'https://marketplace.local/problems/session-required',
				'Session required',
				'X-Session-Id is missing, unknown or expired',
				req.originalUrl,
			)
		}
		return true
	}
}
