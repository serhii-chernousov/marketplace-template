import path from 'node:path'
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Verifier } from '@pact-foundation/pact'
import { DataSource } from 'typeorm'
import { seedVintageLampCatalog } from '../../integration/testkit/seed-catalog'
import {
	startTestDatabase,
	stopTestDatabase,
} from '../../integration/testkit/postgres'
import { listenPrefixProxy } from './prefix-proxy'

describe('Marketplace API provider verification', () => {
	let app: INestApplication
	let ds: DataSource
	let proxy: { port: number; close: () => Promise<void> }

	beforeAll(async () => {
		ds = await startTestDatabase()
		const { AppModule } = await import('../../../src/app.module')
		const { configureApp } = await import('../../../src/configure-app')
		const moduleRef = await Test.createTestingModule({
			imports: [AppModule],
		}).compile()
		app = moduleRef.createNestApplication()
		configureApp(app)
		await app.listen(0, '127.0.0.1')
		const nestUrl = await app.getUrl()
		const nestPort = Number(new URL(nestUrl).port)
		proxy = await listenPrefixProxy(nestPort)
	})

	afterAll(async () => {
		if (proxy) {
			await proxy.close()
		}
		if (app) {
			await app.close()
		}
		await stopTestDatabase()
	})

	it('honours the marketplace-frontend contract', async () => {
		const brokerUrl = process.env.PACT_BROKER_URL
		const providerVersion =
			process.env.PACT_PROVIDER_VERSION ??
			process.env.GITHUB_SHA ??
			'dev'

		const brokerOptions = brokerUrl
			? {
					pactBrokerUrl: brokerUrl,
					pactBrokerToken: process.env.PACT_BROKER_TOKEN,
					publishVerificationResult: true as const,
					providerVersion,
					consumerVersionSelectors: [{ latest: true }],
				}
			: {
					pactUrls: [
						path.resolve(
							process.cwd(),
							'pacts/marketplace-frontend-marketplace-api.json',
						),
					],
				}

		await new Verifier({
			provider: 'marketplace-api',
			providerBaseUrl: `http://127.0.0.1:${proxy.port}`,
			logLevel: 'info',
			stateHandlers: {
				'buyer can purchase listing-1': async () => {
					await seedVintageLampCatalog(ds)
				},
			},
			...brokerOptions,
		}).verifyProvider()
	})
})
