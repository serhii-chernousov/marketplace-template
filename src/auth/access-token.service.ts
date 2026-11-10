import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { randomUUID } from 'node:crypto'
import type { UserRole } from '../entities/user.entity'
import type { AuthUser } from './auth-user'

interface AccessClaims {
	sub: string
	role: UserRole
	sid: string
	jti: string
	exp: number
}

interface VerifiedJwt {
	payload: AccessClaims
}

export class InvalidAccessTokenError extends Error {}

@Injectable()
export class AccessTokenService {
	constructor(private readonly jwt: JwtService) {}

	sign(subject: { id: string; role: UserRole }, familyId: string) {
		return this.jwt.signAsync({
			sub: subject.id,
			role: subject.role,
			sid: familyId,
			jti: randomUUID(),
		})
	}

	/** Key by kid, signature, algorithm allowlist, iss, aud and exp all come from jwtOptions. */
	async verify(token: string): Promise<AuthUser> {
		let verified: VerifiedJwt
		try {
			verified = await this.jwt.verifyAsync<VerifiedJwt>(token, {
				complete: true,
			})
		} catch (err) {
			throw new InvalidAccessTokenError((err as Error).message)
		}
		const { sub, role, sid, jti, exp } = verified.payload
		return { id: sub, role, sid, jti, exp }
	}
}
