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
