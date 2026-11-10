import type { Request } from 'express'
import type { UserRole } from '../entities/user.entity'

/** Identity proven by a verified access token. `role` is a cache valid until `exp`. */
export interface AuthUser {
	id: string
	role: UserRole
	jti: string
	sid: string
	exp: number
}

export type AuthRequest = Request & { user?: AuthUser }
