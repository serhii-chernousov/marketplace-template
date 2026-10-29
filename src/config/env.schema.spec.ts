import { generateKeyPairSync } from 'node:crypto'
import { validateApiEnv, validateWorkerEnv } from './env.schema'

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

const BASE_ENV = {
	PORT: '3000',
	DB_HOST: 'localhost',
	DB_PORT: '5432',
	DB_USER: 'app',
	DB_PASSWORD: 'secret',
	DB_NAME: 'shop',
	DB_URL: 'postgres://app:secret@localhost:5432/shop',
}

const pair = p256Pair()
const AUTH_ENV = {
	JWT_PRIVATE_KEY: pair.privateKey,
	JWT_PUBLIC_KEY: pair.publicKey,
	JWT_KID: 'test',
	REFRESH_TOKEN_PEPPER: 'p'.repeat(32),
}

describe('env schema', () => {
	it('requires BROKER_URL', () => {
		expect(() => validateWorkerEnv(BASE_ENV)).toThrow(/BROKER_URL/)
		expect(
			validateWorkerEnv({ ...BASE_ENV, BROKER_URL: 'amqp://localhost:5672' })
				.BROKER_URL,
		).toBe('amqp://localhost:5672')
	})

	it('names a missing signing key instead of falling back to a default', () => {
		const { JWT_PRIVATE_KEY: _omitted, ...withoutKey } = AUTH_ENV
		expect(() =>
			validateApiEnv({ ...BASE_ENV, BROKER_URL: 'amqp://x', ...withoutKey }),
		).toThrow(/JWT_PRIVATE_KEY/)
	})

	it('rejects a public key that belongs to another pair', () => {
		expect(() =>
			validateApiEnv({
				...BASE_ENV,
				BROKER_URL: 'amqp://x',
				...AUTH_ENV,
				JWT_PUBLIC_KEY: p256Pair().publicKey,
			}),
		).toThrow(/JWT_PUBLIC_KEY: does not match JWT_PRIVATE_KEY/)
	})

	it('accepts a matching P-256 pair', () => {
		expect(
			validateApiEnv({ ...BASE_ENV, BROKER_URL: 'amqp://x', ...AUTH_ENV })
				.JWT_KID,
		).toBe('test')
	})
})
