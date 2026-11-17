import * as pulumi from '@pulumi/pulumi'
import { requireEnv } from './lib/env'

export const vault = requireEnv([
	'DB_PASSWORD',
	'REDIS_PASSWORD',
	'BROKER_PASSWORD',
	'STORAGE_ACCESS_KEY',
	'STORAGE_SECRET_KEY',
	'JWT_PRIVATE_KEY',
	'JWT_PUBLIC_KEY',
	'JWT_KID',
	'REFRESH_TOKEN_PEPPER',
])

/** Only present during a signing-key rotation. */
export const jwtExtraPublicKeys = process.env.JWT_EXTRA_PUBLIC_KEYS ?? ''

export type Profile = 'correct' | 'broken'

const config = new pulumi.Config()

function parseProfile(raw: string): Profile {
	if (raw === 'correct' || raw === 'broken') {
		return raw
	}
	throw new Error(`config profile must be "correct" or "broken", got "${raw}"`)
}

export const profile = parseProfile(config.get('profile') ?? 'correct')
export const rev = config.get('rev') ?? '1'
export const image = config.require('image')
