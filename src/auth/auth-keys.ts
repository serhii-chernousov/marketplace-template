import {
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
} from 'node:crypto'

const decodePem = (base64: string) =>
	Buffer.from(base64, 'base64').toString('utf8')

function assertP256(key: KeyObject): KeyObject {
	if (
		key.asymmetricKeyType !== 'ec' ||
		key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
	) {
		throw new Error('expected an EC P-256 key (ES256)')
	}
	return key
}

export function signingPrivateKey(base64: string): KeyObject {
	return assertP256(createPrivateKey(decodePem(base64)))
}

/** createPublicKey silently derives a public key from private PEM, so the kind is checked first. */
export function verificationPublicKey(base64: string): KeyObject {
	const pem = decodePem(base64)
	if (!pem.includes('PUBLIC KEY-----')) {
		throw new Error('expected a public key PEM')
	}
	return assertP256(createPublicKey(pem))
}

/** Every key a token may be verified with, by kid: the signing key plus any overlap keys. */
export type Keyring = ReadonlyMap<string, KeyObject>

/** `kid:<base64 SPKI PEM>` entries, comma-separated: base64 never contains ':' or ','. */
function parseExtraPublicKeys(
	value: string | undefined,
): Map<string, KeyObject> {
	const keys = new Map<string, KeyObject>()
	const entries = (value ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
	for (const entry of entries) {
		const separator = entry.indexOf(':')
		if (separator < 1) {
			throw new Error('each entry must be kid:<base64 SPKI PEM>')
		}
		const kid = entry.slice(0, separator)
		if (keys.has(kid)) {
			throw new Error(`kid ${kid} is listed twice`)
		}
		keys.set(kid, verificationPublicKey(entry.slice(separator + 1)))
	}
	return keys
}

export function verificationKeyring(
	currentKid: string,
	currentPublicBase64: string,
	extraPublicKeys: string | undefined,
): Keyring {
	const extra = parseExtraPublicKeys(extraPublicKeys)
	if (extra.has(currentKid)) {
		throw new Error(`kid ${currentKid} is already the signing key (JWT_KID)`)
	}
	return new Map([
		[currentKid, verificationPublicKey(currentPublicBase64)],
		...extra,
	])
}

/** Reads kid only to pick a key; nothing in the header is trusted until the signature verifies. */
export function keyIdOf(token: string): string | undefined {
	try {
		const header = JSON.parse(
			Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
		)
		return typeof header.kid === 'string' ? header.kid : undefined
	} catch {
		return undefined
	}
}

export function keyFingerprint(publicKey: KeyObject): string {
	const der = publicKey.export({ type: 'spki', format: 'der' })
	return `SHA256:${createHash('sha256').update(der).digest('base64url')}`
}

export interface KeyProblem {
	variable: 'JWT_PRIVATE_KEY' | 'JWT_PUBLIC_KEY'
	message: string
}

export function signingKeyPairProblem(
	privateBase64: string,
	publicBase64: string,
): KeyProblem | null {
	let privateKey: KeyObject
	let publicKey: KeyObject
	try {
		privateKey = signingPrivateKey(privateBase64)
	} catch (err) {
		return {
			variable: 'JWT_PRIVATE_KEY',
			message: `must be base64 of a PKCS#8 PEM, EC P-256 (${(err as Error).message})`,
		}
	}
	try {
		publicKey = verificationPublicKey(publicBase64)
	} catch (err) {
		return {
			variable: 'JWT_PUBLIC_KEY',
			message: `must be base64 of an SPKI PEM, EC P-256 (${(err as Error).message})`,
		}
	}
	if (
		keyFingerprint(createPublicKey(privateKey)) !== keyFingerprint(publicKey)
	) {
		return {
			variable: 'JWT_PUBLIC_KEY',
			message: 'does not match JWT_PRIVATE_KEY',
		}
	}
	return null
}
