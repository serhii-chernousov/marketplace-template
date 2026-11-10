import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common'
import type { AuthUser } from './auth-user'
import { AuthService } from './auth.service'
import { CurrentUser, Public } from './decorators'

@Controller('v1/auth')
export class AuthController {
	constructor(private readonly auth: AuthService) {}

	@Public()
	@Post('login')
	@HttpCode(200)
	login(@Body() body: { email: string; password: string }) {
		return this.auth.login(body.email, body.password)
	}

	@Public()
	@Post('refresh')
	@HttpCode(200)
	refresh(@Body() body: { refresh_token: string }) {
		return this.auth.refresh(body.refresh_token)
	}

	@Post('logout')
	@HttpCode(204)
	async logout(@CurrentUser() user: AuthUser): Promise<void> {
		await this.auth.logout(user)
	}

	@Get('me')
	me(@CurrentUser() user: AuthUser) {
		return this.auth.me(user)
	}
}
