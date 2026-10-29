import {
	CanActivate,
	ExecutionContext,
	Injectable,
	Logger,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ProblemException } from '../types/problem.exception'
import { AccessTokenService } from './access-token.service'
import type { AuthRequest, AuthUser } from './auth-user'
import { DenyList } from './deny-list'
import { IS_PUBLIC_KEY } from './decorators'
import { unauthorized } from './problems'

/** The OpenAPI validator only checks that the header mentions "bearer"; this is the real parse. */
const BEARER = /^Bearer\s+(\S+)$/i

/**
 * Authentication only: answers "who is this?" with 401 when it cannot.
 * Global, so a new route is closed unless marked @Public().
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
	private readonly logger = new Logger(JwtAuthGuard.name)

	constructor(
		private readonly reflector: Reflector,
		private readonly accessTokens: AccessTokenService,
		private readonly denyList: DenyList,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		if (context.getType() !== 'http') {
			return true
		}
		const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
			context.getHandler(),
			context.getClass(),
		])
		if (isPublic) {
			return true
		}
		const req = context.switchToHttp().getRequest<AuthRequest>()
		const token = BEARER.exec(req.header('authorization') ?? '')?.[1]
		if (!token) {
			throw unauthorized('Bearer access token is required', req.originalUrl)
		}

		let user: AuthUser
		try {
			user = await this.accessTokens.verify(token)
		} catch (err) {
			this.logger.debug(`access token rejected: ${(err as Error).message}`)
			throw unauthorized('Access token is invalid or expired', req.originalUrl)
		}

		if (await this.isDenied(user, req.originalUrl)) {
			throw unauthorized('Access token has been revoked', req.originalUrl)
		}
		req.user = user
		return true
	}

	/** Fail closed with 503, not 401: a 401 would send the client into a refresh loop. */
	private async isDenied(user: AuthUser, instance: string): Promise<boolean> {
		try {
			return await this.denyList.isDenied(user.jti, user.sid)
		} catch (err) {
			this.logger.error(`deny-list unavailable: ${(err as Error).message}`)
			throw new ProblemException(
				503,
				'https://marketplace.local/problems/auth-unavailable',
				'Service Unavailable',
				'Token revocation status cannot be checked right now',
				instance,
			)
		}
	}
}
