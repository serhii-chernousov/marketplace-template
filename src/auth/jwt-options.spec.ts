import type { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { generateKeyPairSync } from 'node:crypto'
import type { ApiEnv } from '../config/env.schema'
import {
	AccessTokenService,
	InvalidAccessTokenError,
} from './access-token.service'
import { jwtOptions } from './jwt-options'

function p256Pair() {
	const { privateKey, publicKey } = generateKeyPairSync('ec', {
		namedCurve: 'P-256',
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	})
	return {
		privateKey: Buffer.from(privateKey).toString('base64'),
		publicKey: Buffer.from(publicKey).toString('base64'),
	}
}

function tokens(
	kid: string,
	pair: { privateKey: string; publicKey: string },
	extraPublicKeys?: string,
): AccessTokenService {
	const env: Partial<ApiEnv> = {
		JWT_KID: kid,
		JWT_PRIVATE_KEY: pair.privateKey,
		JWT_PUBLIC_KEY: pair.publicKey,
		JWT_EXTRA_PUBLIC_KEYS: extraPublicKeys,
	}
	const config = {
		get: (key: keyof ApiEnv) => env[key],
	} as unknown as ConfigService<ApiEnv, true>
	return new AccessTokenService(new JwtService(jwtOptions(config)))
}

const BUYER = { id: '7', role: 'buyer' as const }

describe('ES256 key rotation by kid', () => {
	const oldPair = p256Pair()
	const newPair = p256Pair()
	const beforeRotation = tokens('old', oldPair)
	const duringOverlap = tokens('new', newPair, `old:${oldPair.publicKey}`)
	const afterOverlap = tokens('new', newPair)

	it('accepts tokens of both keys while the old one is in the keyring', async () => {
		const oldToken = await beforeRotation.sign(BUYER, 'family-1')
		const newToken = await duringOverlap.sign(BUYER, 'family-2')

		await expect(duringOverlap.verify(oldToken)).resolves.toMatchObject({
			id: '7',
			sid: 'family-1',
		})
		await expect(duringOverlap.verify(newToken)).resolves.toMatchObject({
			sid: 'family-2',
		})
	})

	it('rejects the old key once the overlap is over', async () => {
		const oldToken = await beforeRotation.sign(BUYER, 'family-1')
		await expect(afterOverlap.verify(oldToken)).rejects.toBeInstanceOf(
			InvalidAccessTokenError,
		)
	})

	it('rejects an unknown kid and a kid that does not match the signing key', async () => {
		const strangerToken = await tokens('stranger', p256Pair()).sign(
			BUYER,
			'family-3',
		)
		const forgedKid = await tokens('old', p256Pair()).sign(BUYER, 'family-4')

		await expect(duringOverlap.verify(strangerToken)).rejects.toBeInstanceOf(
			InvalidAccessTokenError,
		)
		await expect(duringOverlap.verify(forgedKid)).rejects.toBeInstanceOf(
			InvalidAccessTokenError,
		)
	})
})
