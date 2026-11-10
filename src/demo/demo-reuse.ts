import { printMetrics } from './print-metrics'
import {
	meetsExpectations,
	resetDemoAccounts,
	runDemo,
	startDemoApp,
} from './auth-demo-kit'

const PORT = 3402

const EXPECTED = {
	login: [200],
	'r1-refresh': [200],
	'r1-reuse': [401],
	'r2-after-reuse': [401],
}

/**
 * Rotation alone is not enough: a thief who refreshes first keeps a live
 * session. Presenting the already-used r1 is the compromise signal, so the
 * whole family dies — r2-after-reuse=401 means the honest client is out too.
 */
runDemo(async () => {
	const { app, dataSource, call } = await startDemoApp(PORT)
	try {
		const [account] = await resetDemoAccounts(dataSource, [
			{ email: 'demo-reuse@shop.local', role: 'buyer' },
		])

		const login = await call('POST', '/v1/auth/login', {
			body: { email: account.email, password: account.password },
		})
		const r1 = login.body.refresh_token
		const r1Refresh = await call('POST', '/v1/auth/refresh', {
			body: { refresh_token: r1 },
		})
		const r1Reuse = await call('POST', '/v1/auth/refresh', {
			body: { refresh_token: r1 },
		})
		const r2AfterReuse = await call('POST', '/v1/auth/refresh', {
			body: { refresh_token: r1Refresh.body.refresh_token },
		})

		const metrics = {
			login: login.status,
			'r1-refresh': r1Refresh.status,
			'r1-reuse': r1Reuse.status,
			'r2-after-reuse': r2AfterReuse.status,
		}
		printMetrics(metrics)
		return meetsExpectations(metrics, EXPECTED) ? 0 : 1
	} finally {
		await app.close()
	}
})
