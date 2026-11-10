import { Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { JwtSecretRequestType, type JwtModuleOptions } from '@nestjs/jwt'
import type { ApiEnv } from '../config/env.schema'
import {
	ACCESS_TOKEN_TTL_SEC,
	JWT_AUDIENCE,
	JWT_ISSUER,
} from './auth.constants'
import {
	keyFingerprint,
	keyIdOf,
	signingPrivateKey,
	verificationKeyring,
} from './auth-keys'

/**
 * Signing always uses JWT_KID's key. Verification picks the key by the
 * token's kid from the keyring, so during a key rotation tokens signed by
 * either key stay valid; an unknown kid fails verification.
 */
export function jwtOptions(
	config: ConfigService<ApiEnv, true>,
): JwtModuleOptions {
	const kid = config.get('JWT_KID', { infer: true })
	const privateKey = signingPrivateKey(
		config.get('JWT_PRIVATE_KEY', { infer: true }),
	)
	const keyring = verificationKeyring(
		kid,
		config.get('JWT_PUBLIC_KEY', { infer: true }),
		config.get('JWT_EXTRA_PUBLIC_KEYS', { infer: true }),
	)

	const logger = new Logger('Auth')
	logger.log(`ES256 signing kid=${kid}`)
	for (const [keyId, publicKey] of keyring) {
		logger.log(
			`ES256 verification kid=${keyId} fingerprint=${keyFingerprint(publicKey)}`,
		)
	}

	return {
		secretOrKeyProvider: (requestType, token) => {
			if (requestType === JwtSecretRequestType.SIGN) {
				return privateKey
			}
			const publicKey = keyring.get(keyIdOf(String(token)) ?? '')
			if (!publicKey) {
				throw new Error('unknown kid')
			}
			return publicKey
		},
		signOptions: {
			algorithm: 'ES256',
			keyid: kid,
			issuer: JWT_ISSUER,
			audience: JWT_AUDIENCE,
			expiresIn: ACCESS_TOKEN_TTL_SEC,
		},
		verifyOptions: {
			algorithms: ['ES256'],
			issuer: JWT_ISSUER,
			audience: JWT_AUDIENCE,
		},
	}
}
