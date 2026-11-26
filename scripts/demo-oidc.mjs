#!/usr/bin/env node
// Three tokens signed with a key pair born in this process, served through a
// local issuer, each judged by the very gate the pipeline runs.
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'

const POLICY = 'oidc/policy.json'
const policy = JSON.parse(readFileSync(POLICY, 'utf8'))
const kid = randomUUID()
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
})
const jwk = {
	...publicKey.export({ format: 'jwk' }),
	kid,
	alg: 'RS256',
	use: 'sig',
}

const server = createServer((req, res) => {
	const body =
		req.url === '/.well-known/openid-configuration'
			? { issuer, jwks_uri: `${issuer}/jwks` }
			: req.url === '/jwks'
				? { keys: [jwk] }
				: null
	res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
	res.end(JSON.stringify(body ?? {}))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const issuer = `http://127.0.0.1:${server.address().port}`

const sign = (sub) =>
	new SignJWT({ repository: sub.split(':')[1] })
		.setProtectedHeader({ alg: 'RS256', kid })
		.setIssuer(issuer)
		.setAudience(policy.audience)
		.setSubject(sub)
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(privateKey)

const green = await sign(policy.subjects[0])
const cases = [
	['green', green],
	[
		'foreign-sub',
		await sign('repo:attacker/marketplace-template:environment:pr'),
	],
	['bad-signature', tamperSignature(green)],
]

const dir = mkdtempSync(join(tmpdir(), 'demo-oidc-'))
try {
	for (const [name, token] of cases) {
		const file = join(dir, `${name}.jwt`)
		writeFileSync(file, token, { mode: 0o600 })
		const gate = await runGate(file)
		console.log(`case=${name}`)
		process.stdout.write(gate.stdout)
		console.log(`gate-exit=${gate.status}`)
		console.log('')
	}
} finally {
	rmSync(dir, { recursive: true, force: true })
	server.close()
}

// The last base64url character may carry only padding bits, so flipping it can
// leave the decoded signature unchanged; flip one in the middle instead.
function tamperSignature(jwt) {
	const [header, payload, signature] = jwt.split('.')
	const i = Math.floor(signature.length / 2)
	const flipped = signature[i] === 'A' ? 'B' : 'A'
	return [
		header,
		payload,
		signature.slice(0, i) + flipped + signature.slice(i + 1),
	].join('.')
}

// Async spawn: the gate fetches keys from the server running in this process.
function runGate(tokenFile) {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				'scripts/oidc-gate.mjs',
				'--token-file',
				tokenFile,
				'--policy',
				POLICY,
				'--issuer',
				issuer,
			],
			{ stdio: ['ignore', 'pipe', 'ignore'] },
		)
		let stdout = ''
		child.stdout.on('data', (d) => (stdout += d))
		child.on('close', (status) => resolve({ status, stdout }))
	})
}
