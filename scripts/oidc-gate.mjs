#!/usr/bin/env node
// Verifies an OIDC ID token against the issuer's published keys, then applies
// the trust policy. Prints the claims it decided on, never the token itself.
// Usage: oidc-gate.mjs --token-file <path> --policy <path> [--issuer <url>] [--audience <aud>]
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const { values: args } = parseArgs({
	options: {
		'token-file': { type: 'string' },
		policy: { type: 'string', default: 'oidc/policy.json' },
		issuer: { type: 'string' },
		audience: { type: 'string' },
	},
})

if (!args['token-file']) {
	console.error(
		'usage: oidc-gate.mjs --token-file <path> --policy <path> [--issuer <url>] [--audience <aud>]',
	)
	process.exit(2)
}

const policy = JSON.parse(readFileSync(args.policy, 'utf8'))
const issuer = args.issuer ?? policy.issuer
const audience = args.audience ?? policy.audience
const token = readFileSync(args['token-file'], 'utf8').trim()

const payload = await verifySignature(token, issuer)
const sigVerified = payload !== null
const claims = payload ?? {}
const audiences = [claims.aud].flat()
const policyAllow =
	sigVerified &&
	claims.iss === issuer &&
	audiences.includes(audience) &&
	policy.subjects.includes(claims.sub)

console.log(`oidc-iss=${claims.iss ?? ''}`)
console.log(`oidc-aud=${audiences.filter(Boolean).join(',')}`)
console.log(`oidc-sub=${claims.sub ?? ''}`)
console.log(`sig-verified=${sigVerified ? 1 : 0}`)
console.log(`policy-allow=${policyAllow ? 1 : 0}`)
process.exit(policyAllow ? 0 : 1)

// iss/aud/sub are judged by the policy step, not here: a valid signature on a
// foreign subject must still read as sig-verified=1.
async function verifySignature(jwt, iss) {
	try {
		const discovery = await fetch(
			new URL('.well-known/openid-configuration', withSlash(iss)),
		)
		if (!discovery.ok)
			throw new Error(`openid-configuration: HTTP ${discovery.status}`)
		const { jwks_uri: jwksUri } = await discovery.json()
		const keys = createRemoteJWKSet(new URL(jwksUri))
		const { payload } = await jwtVerify(jwt, keys, { algorithms: ['RS256'] })
		return payload
	} catch (error) {
		console.error(`signature check failed: ${error.code ?? error.message}`)
		return null
	}
}

function withSlash(url) {
	return url.endsWith('/') ? url : `${url}/`
}
