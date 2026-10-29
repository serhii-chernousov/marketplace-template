import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { User } from '../entities/user.entity'
import { AccessTokenService } from './access-token.service'
import { ACCESS_TOKEN_TTL_SEC } from './auth.constants'
import type { AuthUser } from './auth-user'
import { DenyList } from './deny-list'
import { verifyPassword } from './password'
import { unauthorized } from './problems'
import { RefreshTokenService } from './refresh-token.service'

export interface TokenPair {
	access_token: string
	refresh_token: string
	token_type: 'Bearer'
	expires_in: number
}

@Injectable()
export class AuthService {
	private readonly logger = new Logger(AuthService.name)

	constructor(
		private readonly dataSource: DataSource,
		private readonly accessTokens: AccessTokenService,
		private readonly refreshTokens: RefreshTokenService,
		private readonly denyList: DenyList,
	) {}

	async login(email: string, password: string): Promise<TokenPair> {
		const user = await this.dataSource
			.getRepository(User)
			.createQueryBuilder('user')
			.addSelect('user.passwordHash')
			.where('user.email = :email', { email })
			.getOne()
		const passwordOk = await verifyPassword(password, user?.passwordHash)
		if (!user || !passwordOk || !user.isActive) {
			throw unauthorized('Invalid email or password', '/v1/auth/login')
		}
		const familyId = randomUUID()
		const refreshToken = await this.refreshTokens.issue(
			this.dataSource.manager,
			user.id,
			familyId,
		)
		return this.pair(user, familyId, refreshToken)
	}

	async refresh(refreshToken: string): Promise<TokenPair> {
		const rotation = await this.refreshTokens.rotate(refreshToken)
		if (rotation.kind === 'reused') {
			this.logger.warn(
				`refresh token reuse detected: family_id=${rotation.familyId} user_id=${rotation.userId}, family revoked`,
			)
			await this.denyFamilyBestEffort(rotation.familyId)
		}
		if (rotation.kind !== 'rotated') {
			throw unauthorized(
				'Refresh token is invalid, expired, revoked or already used',
				'/v1/auth/refresh',
			)
		}
		return this.pair(rotation.user, rotation.familyId, rotation.refreshToken)
	}

	/**
	 * Two stores, so not atomic: the family is revoked in Postgres first, then
	 * the access token is denied in Redis. Both writes are idempotent and the
	 * response is 2xx only after both, so a client retries a failed logout —
	 * and the retry still passes the guard because Redis was the step that failed.
	 */
	async logout(user: AuthUser): Promise<void> {
		await this.refreshTokens.revokeFamily(user.sid)
		await Promise.all([
			this.denyList.denyToken(user.jti, user.exp),
			this.denyList.denyFamily(user.sid),
		])
	}

	async me(user: AuthUser) {
		const account = await this.dataSource
			.getRepository(User)
			.findOneBy({ id: user.id })
		if (!account) {
			throw unauthorized('Account no longer exists', '/v1/auth/me')
		}
		return { id: account.id, email: account.email, role: account.role }
	}

	private async pair(
		user: User,
		familyId: string,
		refreshToken: string,
	): Promise<TokenPair> {
		return {
			access_token: await this.accessTokens.sign(user, familyId),
			refresh_token: refreshToken,
			token_type: 'Bearer',
			expires_in: ACCESS_TOKEN_TTL_SEC,
		}
	}

	/** The family is already revoked in Postgres; this only shortens the life of its access tokens. */
	private async denyFamilyBestEffort(familyId: string): Promise<void> {
		try {
			await this.denyList.denyFamily(familyId)
		} catch (err) {
			this.logger.error(
				`deny-list write failed for family_id=${familyId}: ${(err as Error).message}`,
			)
		}
	}
}
