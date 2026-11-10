// Usage:
//   node scripts/jwt-keygen.mjs <kid>            prints JWT_KID / JWT_PRIVATE_KEY / JWT_PUBLIC_KEY for the vault
//   bash scripts/with-secrets.sh <env> node scripts/jwt-keygen.mjs --fingerprint
//                                                fingerprint of JWT_PUBLIC_KEY in that vault env
// Keys go to stdout only (pipe them into the vault), never into a file in the repo.
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'

const fingerprint = (publicKeyPem) =>
	'SHA256:' +
	createHash('sha256')
		.update(
			createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }),
		)
		.digest('base64url')

if (process.argv[2] === '--fingerprint') {
	const encoded = process.env.JWT_PUBLIC_KEY
	if (!encoded) {
		console.error('JWT_PUBLIC_KEY is not set')
		process.exit(1)
	}
	console.log(
		`kid=${process.env.JWT_KID ?? '?'} ${fingerprint(Buffer.from(encoded, 'base64').toString('utf8'))}`,
	)
	process.exit(0)
}

const kid = process.argv[2]
if (!kid) {
	console.error('usage: node scripts/jwt-keygen.mjs <kid> | --fingerprint')
	process.exit(1)
}
const { privateKey, publicKey } = generateKeyPairSync('ec', {
	namedCurve: 'P-256',
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
})
console.log(`JWT_KID=${kid}`)
console.log(`JWT_PRIVATE_KEY=${Buffer.from(privateKey).toString('base64')}`)
console.log(`JWT_PUBLIC_KEY=${Buffer.from(publicKey).toString('base64')}`)
console.error(`kid=${kid} ${fingerprint(publicKey)}`)
