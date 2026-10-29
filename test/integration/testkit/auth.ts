import type { INestApplication } from '@nestjs/common'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import type Redis from 'ioredis'
import { DataSource } from 'typeorm'
import { AccessTokenService } from '../../../src/auth/access-token.service'
import { User } from '../../../src/entities/user.entity'

/** A throwaway ES256 pair per test process — real keys never reach tests. */
export function applyTestAuthEnv(): void {
	if (process.env.JWT_PRIVATE_KEY) {
		return
	}
	const { privateKey, publicKey } = generateKeyPairSync('ec', {
		namedCurve: 'P-256',
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	})
	process.env.JWT_PRIVATE_KEY = Buffer.from(privateKey).toString('base64')
	process.env.JWT_PUBLIC_KEY = Buffer.from(publicKey).toString('base64')
	process.env.JWT_KID = 'test'
	process.env.REFRESH_TOKEN_PEPPER = randomBytes(32).toString('base64url')
}

/** Stands in for QUEUE_REDIS where no Redis runs (CI): empty deny-list, rate limit fails open. */
export function emptyDenyListRedis(): Redis {
	return {
		exists: async () => 0,
		disconnect: () => undefined,
	} as unknown as Redis
}

export async function bearerFor(
	app: INestApplication,
	email: string,
): Promise<string> {
	const user = await app
		.get(DataSource)
		.getRepository(User)
		.findOneByOrFail({ email })
	const token = await app.get(AccessTokenService).sign(user, randomUUID())
	return `Bearer ${token}`
}
