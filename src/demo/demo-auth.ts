import { printMetrics } from './print-metrics'
import {
	meetsExpectations,
	resetDemoAccounts,
	runDemo,
	startDemoApp,
} from './auth-demo-kit'

const PORT = 3401

const EXPECTED = {
	login: [200],
	'no-token': [401],
	'with-token': [200],
	refresh: [200],
	logout: [200, 204],
	'after-logout': [401],
	'refresh-after-logout': [401],
}

/**
 * Logout kills both halves of a session. The refresh token is a row, so a
 * revoked_at is enough; the access token is self-contained and would live
 * until exp — after-logout=401 is the deny-list doing its job.
 */
runDemo(async () => {
	const { app, dataSource, call } = await startDemoApp(PORT)
	try {
		const [account] = await resetDemoAccounts(dataSource, [
			{ email: 'demo-auth@shop.local', role: 'buyer' },
		])

		const login = await call('POST', '/v1/auth/login', {
			body: { email: account.email, password: account.password },
		})
		const noToken = await call('GET', '/v1/auth/me')
		const withToken = await call('GET', '/v1/auth/me', {
			token: String(login.body.access_token),
		})
		const refresh = await call('POST', '/v1/auth/refresh', {
			body: { refresh_token: login.body.refresh_token },
		})
		const access = String(refresh.body.access_token)
		const logout = await call('POST', '/v1/auth/logout', { token: access })
		const afterLogout = await call('GET', '/v1/auth/me', { token: access })
		const refreshAfterLogout = await call('POST', '/v1/auth/refresh', {
			body: { refresh_token: refresh.body.refresh_token },
		})

		const metrics = {
			login: login.status,
			'no-token': noToken.status,
			'with-token': withToken.status,
			refresh: refresh.status,
			logout: logout.status,
			'after-logout': afterLogout.status,
			'refresh-after-logout': refreshAfterLogout.status,
		}
		printMetrics(metrics)
		return meetsExpectations(metrics, EXPECTED) ? 0 : 1
	} finally {
		await app.close()
	}
})
