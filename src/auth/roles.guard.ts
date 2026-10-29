import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { UserRole } from '../entities/user.entity'
import type { AuthRequest } from './auth-user'
import { ROLES_KEY } from './decorators'
import { forbidden } from './problems'

/** Authorization by role only: the token is valid (JwtAuthGuard ran first), the role is not enough → 403. */
@Injectable()
export class RolesGuard implements CanActivate {
	constructor(private readonly reflector: Reflector) {}

	canActivate(context: ExecutionContext): boolean {
		const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(
			ROLES_KEY,
			[context.getHandler(), context.getClass()],
		)
		if (!roles || context.getType() !== 'http') {
			return true
		}
		const req = context.switchToHttp().getRequest<AuthRequest>()
		if (!req.user || !roles.includes(req.user.role)) {
			throw forbidden(`Requires role: ${roles.join(' or ')}`, req.originalUrl)
		}
		return true
	}
}
