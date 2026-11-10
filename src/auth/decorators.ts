import {
	createParamDecorator,
	SetMetadata,
	type ExecutionContext,
} from '@nestjs/common'
import type { UserRole } from '../entities/user.entity'
import type { AuthRequest, AuthUser } from './auth-user'

export const IS_PUBLIC_KEY = 'auth:public'
export const ROLES_KEY = 'auth:roles'

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles)

export const CurrentUser = createParamDecorator(
	(_data: unknown, context: ExecutionContext): AuthUser => {
		const req = context.switchToHttp().getRequest<AuthRequest>()
		return req.user as AuthUser
	},
)
