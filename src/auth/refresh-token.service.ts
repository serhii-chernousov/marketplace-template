import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHmac, randomBytes } from 'node:crypto'
import { DataSource, IsNull, type EntityManager } from 'typeorm'
import type { ApiEnv } from '../config/env.schema'
import { RefreshToken } from '../entities/refresh-token.entity'
import { User } from '../entities/user.entity'
import { REFRESH_TOKEN_TTL_SEC } from './auth.constants'

export type Rotation =
	| { kind: 'rotated'; user: User; familyId: string; refreshToken: string }
	| { kind: 'reused'; familyId: string; userId: string }
	| { kind: 'rejected' }

@Injectable()
export class RefreshTokenService {
	private readonly pepper: string

	constructor(
		private readonly dataSource: DataSource,
		config: ConfigService<ApiEnv, true>,
	) {
		this.pepper = config.get('REFRESH_TOKEN_PEPPER', { infer: true })
	}

	async issue(
		manager: EntityManager,
		userId: string,
		familyId: string,
	): Promise<string> {
		const token = randomBytes(32).toString('base64url')
		await manager.insert(RefreshToken, {
			userId,
			familyId,
			tokenHash: this.hash(token),
			expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
		})
		return token
	}

	/**
	 * One transaction: the row lock serialises concurrent refreshes of the same
	 * token, and a detected reuse commits the family revocation before the
	 * caller turns it into 401 (throwing here would roll it back).
	 */
	rotate(token: string): Promise<Rotation> {
		return this.dataSource.transaction(async (manager) => {
			const current = await manager.findOne(RefreshToken, {
				where: { tokenHash: this.hash(token) },
				lock: { mode: 'pessimistic_write' },
			})
			if (!current) {
				return { kind: 'rejected' }
			}
			if (current.usedAt) {
				await this.revokeFamily(current.familyId, manager)
				return {
					kind: 'reused',
					familyId: current.familyId,
					userId: current.userId,
				}
			}
			if (current.revokedAt || current.expiresAt <= new Date()) {
				return { kind: 'rejected' }
			}
			const user = await manager.findOne(User, {
				where: { id: current.userId },
			})
			if (!user?.isActive) {
				await this.revokeFamily(current.familyId, manager)
				return { kind: 'rejected' }
			}
			await manager.update(RefreshToken, current.id, { usedAt: new Date() })
			const refreshToken = await this.issue(manager, user.id, current.familyId)
			return { kind: 'rotated', user, familyId: current.familyId, refreshToken }
		})
	}

	async revokeFamily(
		familyId: string,
		manager: EntityManager = this.dataSource.manager,
	): Promise<void> {
		await manager.update(
			RefreshToken,
			{ familyId, revokedAt: IsNull() },
			{ revokedAt: new Date() },
		)
	}

	private hash(token: string): string {
		return createHmac('sha256', this.pepper).update(token).digest('hex')
	}
}
