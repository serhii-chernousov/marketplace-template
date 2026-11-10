import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { AccessTokenService } from './access-token.service'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { DenyList } from './deny-list'
import { jwtOptions } from './jwt-options'
import { RefreshTokenService } from './refresh-token.service'

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
