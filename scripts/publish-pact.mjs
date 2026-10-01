import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { Publisher } = require('@pact-foundation/pact')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brokerUrl = process.env.PACT_BROKER_URL
if (!brokerUrl) {
	console.error('PACT_BROKER_URL is required to publish pacts')
	process.exit(1)
}

const consumerVersion =
	process.env.GITHUB_SHA ?? process.env.PACT_CONSUMER_VERSION ?? '1.0.0'

const publisher = new Publisher({
	pactFilesOrDirs: [path.join(root, 'pacts')],
	pactBroker: brokerUrl,
	pactBrokerToken: process.env.PACT_BROKER_TOKEN,
	consumerVersion,
})

publisher
	.publishPacts()
	.then(() => {
		console.log(`Published pacts as consumer version ${consumerVersion}`)
	})
	.catch((err) => {
		console.error(err)
		process.exit(1)
	})
