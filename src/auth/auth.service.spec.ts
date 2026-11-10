import type { DataSource } from 'typeorm'
import { ProblemException } from '../types/problem.exception'
import type { AccessTokenService } from './access-token.service'
import { AuthService } from './auth.service'
import type { DenyList } from './deny-list'
import type { RefreshTokenService, Rotation } from './refresh-token.service'

function service(rotation: Rotation, denyFamily: jest.Mock) {
	const refreshTokens = {
		rotate: jest.fn().mockResolvedValue(rotation),
	} as unknown as RefreshTokenService
	const denyList = { denyFamily } as unknown as DenyList
	return new AuthService(
		{} as DataSource,
		{} as AccessTokenService,
		refreshTokens,
		denyList,
	)
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
	const err = await promise.catch((e: unknown) => e)
	return err instanceof ProblemException ? err.status : -1
}

describe('AuthService.refresh after a family is revoked', () => {
	const revokedAt = new Date()

	it('answers 503 instead of swallowing a failed deny-list write on reuse', async () => {
		const denyFamily = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
		const auth = service(
			{ kind: 'reused', familyId: 'f1', userId: '7', revokedAt },
			denyFamily,
		)

		expect(await statusOf(auth.refresh('r1'))).toBe(503)
		expect(denyFamily).toHaveBeenCalledWith('f1', revokedAt)
	})

	it('answers 401 once the family is denied', async () => {
		const denyFamily = jest.fn().mockResolvedValue(undefined)
		const auth = service(
			{ kind: 'reused', familyId: 'f1', userId: '7', revokedAt },
			denyFamily,
		)

		expect(await statusOf(auth.refresh('r1'))).toBe(401)
	})

	it('re-applies the family deny entry when a revoked token comes back', async () => {
		const denyFamily = jest.fn().mockResolvedValue(undefined)
		const auth = service(
			{ kind: 'revoked', familyId: 'f1', revokedAt },
			denyFamily,
		)

		expect(await statusOf(auth.refresh('r2'))).toBe(401)
		expect(denyFamily).toHaveBeenCalledWith('f1', revokedAt)
	})
})
