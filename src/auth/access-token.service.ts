import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { randomUUID } from 'node:crypto'
import type { ApiEnv } from '../config/env.schema'
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
	header: { kid?: string }
	payload: AccessClaims
}

export class InvalidAccessTokenError extends Error {}

@Injectable()
export class AccessTokenService {
	private readonly kid: string

	constructor(
		private readonly jwt: JwtService,
		config: ConfigService<ApiEnv, true>,
	) {
		this.kid = config.get('JWT_KID', { infer: true })
	}

	sign(subject: { id: string; role: UserRole }, familyId: string) {
		return this.jwt.signAsync({
			sub: subject.id,
			role: subject.role,
			sid: familyId,
			jti: randomUUID(),
		})
	}

	/** Signature, algorithm allowlist, iss, aud and exp are checked by verifyOptions of JwtModule. */
	async verify(token: string): Promise<AuthUser> {
		let verified: VerifiedJwt
		try {
			verified = await this.jwt.verifyAsync<VerifiedJwt>(token, {
				complete: true,
			})
		} catch (err) {
			throw new InvalidAccessTokenError((err as Error).message)
		}
		if (verified.header.kid !== this.kid) {
			throw new InvalidAccessTokenError('unknown kid')
		}
		const { sub, role, sid, jti, exp } = verified.payload
		return { id: sub, role, sid, jti, exp }
	}
}
