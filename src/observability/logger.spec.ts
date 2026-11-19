import { Writable } from 'node:stream'
import { createLogger } from './logger'

function capture() {
	const lines: string[] = []
	const stream = new Writable({
		write(chunk: Buffer, _enc, done) {
			lines.push(chunk.toString())
			done()
		},
	})
	return { logger: createLogger(stream), output: () => lines.join('') }
}

describe('logger redaction', () => {
	it('hides the bearer token and passwords on the paths it lists', () => {
		const { logger, output } = capture()
		logger.info(
			{
				req: {
					headers: { authorization: 'Bearer tok-SECRET-1', cookie: 'sid=x' },
					body: { password: 'pw-SECRET-2' },
				},
				login: { password: 'pw-SECRET-3', refresh_token: 'rt-SECRET-4' },
			},
			'request completed',
		)
		expect(output()).not.toMatch(/SECRET/)
		expect(output()).toContain('[REDACTED]')
	})

	it('does not guess deeper paths: a nested object without a listed path leaks', () => {
		const { logger, output } = capture()
		logger.info({ user: { credentials: { password: 'pw-NESTED' } } }, 'oops')
		expect(output()).toContain('pw-NESTED')
	})

	it('writes one JSON object per line', () => {
		const { logger, output } = capture()
		logger.child({ layer: 'orders.repo' }).info('row loaded')
		const line = JSON.parse(output().trim())
		expect(line.layer).toBe('orders.repo')
		expect(line.msg).toBe('row loaded')
	})
})
