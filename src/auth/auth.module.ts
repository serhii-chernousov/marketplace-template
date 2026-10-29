import { Global, Logger, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt'
import type { ApiEnv } from '../config/env.schema'
import { AccessTokenService } from './access-token.service'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import {
	JWT_AUDIENCE,
	JWT_ISSUER,
	ACCESS_TOKEN_TTL_SEC,
} from './auth.constants'
import {
	keyFingerprint,
	signingPrivateKey,
	verificationPublicKey,
} from './auth-keys'
import { DenyList } from './deny-list'
import { RefreshTokenService } from './refresh-token.service'

function jwtOptions(config: ConfigService<ApiEnv, true>): JwtModuleOptions {
	const kid = config.get('JWT_KID', { infer: true })
	const publicKey = verificationPublicKey(
		config.get('JWT_PUBLIC_KEY', { infer: true }),
	)
	new Logger('Auth').log(
		`ES256 signing key kid=${kid} fingerprint=${keyFingerprint(publicKey)}`,
	)
	return {
		privateKey: signingPrivateKey(
			config.get('JWT_PRIVATE_KEY', { infer: true }),
		),
		publicKey,
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

@Global()
@Module({
	imports: [
		JwtModule.registerAsync({
			inject: [ConfigService],
			useFactory: jwtOptions,
		}),
	],
	controllers: [AuthController],
	providers: [AccessTokenService, RefreshTokenService, DenyList, AuthService],
	exports: [AccessTokenService, DenyList],
})
export class AuthModule {}
