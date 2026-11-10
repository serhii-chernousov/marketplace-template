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
	REDIS_URL: 'redis://localhost:16379',
	REDIS_QUEUE_URL: 'redis://localhost:16380',
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

	it('names a missing REDIS_QUEUE_URL at validation, not later in RedisModule', () => {
		const { REDIS_QUEUE_URL: _omitted, ...withoutQueue } = BASE_ENV
		expect(() =>
			validateWorkerEnv({ ...withoutQueue, BROKER_URL: 'amqp://x' }),
		).toThrow(/REDIS_QUEUE_URL/)
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

	it('accepts overlap keys as kid:<base64 SPKI PEM> and rejects malformed ones', () => {
		const env = { ...BASE_ENV, BROKER_URL: 'amqp://x', ...AUTH_ENV }
		expect(
			validateApiEnv({
				...env,
				JWT_EXTRA_PUBLIC_KEYS: `previous:${p256Pair().publicKey}`,
			}).JWT_EXTRA_PUBLIC_KEYS,
		).toMatch(/^previous:/)
		expect(() =>
			validateApiEnv({ ...env, JWT_EXTRA_PUBLIC_KEYS: p256Pair().publicKey }),
		).toThrow(/JWT_EXTRA_PUBLIC_KEYS: each entry must be kid/)
		expect(() =>
			validateApiEnv({
				...env,
				JWT_EXTRA_PUBLIC_KEYS: `test:${p256Pair().publicKey}`,
			}),
		).toThrow(/JWT_EXTRA_PUBLIC_KEYS: kid test is already the signing key/)
	})

	it('accepts a matching P-256 pair', () => {
		expect(
			validateApiEnv({ ...BASE_ENV, BROKER_URL: 'amqp://x', ...AUTH_ENV })
				.JWT_KID,
		).toBe('test')
	})
})
