import { validate } from './env.schema'

const BASE_ENV = {
	PORT: '3000',
	DB_HOST: 'localhost',
	DB_PORT: '5432',
	DB_USER: 'app',
	DB_PASSWORD: 'secret',
	DB_NAME: 'shop',
	DB_URL: 'postgres://app:secret@localhost:5432/shop',
}

describe('env schema', () => {
	it('requires BROKER_URL', () => {
		expect(() => validate(BASE_ENV)).toThrow(/BROKER_URL/)
		expect(
			validate({ ...BASE_ENV, BROKER_URL: 'amqp://localhost:5672' }).BROKER_URL,
		).toBe('amqp://localhost:5672')
	})
})
