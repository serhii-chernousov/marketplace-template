import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brokerUrl = process.env.PACT_BROKER_URL?.replace(/\/$/, '')
if (!brokerUrl) {
	console.error('PACT_BROKER_URL is required to publish pacts')
	process.exit(1)
}

const consumerVersion =
	process.env.PACT_CONSUMER_VERSION ?? process.env.GITHUB_SHA ?? '1.0.0'
const token = process.env.PACT_BROKER_TOKEN

const pactsDir = path.join(root, 'pacts')
const pactFiles = fs
	.readdirSync(pactsDir)
	.filter((name) => name.endsWith('.json'))
	.map((name) => path.join(pactsDir, name))

if (pactFiles.length === 0) {
	console.error(`No pact files found in ${pactsDir}`)
	process.exit(1)
}

const headers = {
	'Content-Type': 'application/json',
}
if (token) {
	headers.Authorization = `Bearer ${token}`
}

for (const file of pactFiles) {
	const body = fs.readFileSync(file, 'utf8')
	const pact = JSON.parse(body)
	const consumer = pact.consumer?.name
	const provider = pact.provider?.name
	if (!consumer || !provider) {
		console.error(`Pact ${file} is missing consumer/provider name`)
		process.exit(1)
	}

	const url =
		`${brokerUrl}/pacts/provider/${encodeURIComponent(provider)}` +
		`/consumer/${encodeURIComponent(consumer)}` +
		`/version/${encodeURIComponent(consumerVersion)}`

	const res = await fetch(url, {
		method: 'PUT',
		headers,
		body,
	})
	if (!res.ok) {
		const text = await res.text()
		console.error(`Failed to publish ${path.basename(file)}: ${res.status}`)
		console.error(text)
		process.exit(1)
	}
	console.log(
		`Published ${path.basename(file)} as ${consumer}@${consumerVersion} → ${provider} (${res.status})`,
	)
}
