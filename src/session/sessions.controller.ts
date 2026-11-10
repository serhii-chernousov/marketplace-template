import {
	Controller,
	Delete,
	Get,
	HttpCode,
	Post,
	Req,
	UseGuards,
} from '@nestjs/common'
import type { AuthUser } from '../auth/auth-user'
import { CurrentUser, Public } from '../auth/decorators'
import { RateLimit } from '../ratelimit/rate-limit.decorator'
import { SessionStore } from './session-store'
import { SessionGuard } from './session.guard'
import type { ActiveSession, SessionRequest } from './session.middleware'

/** Opening a session needs an access token; using one needs only X-Session-Id. */
@Controller('v1/sessions')
export class SessionsController {
	constructor(private readonly store: SessionStore) {}

	@Post()
	@HttpCode(201)
	@RateLimit({ limit: 5, windowMs: 60_000 })
	async create(@CurrentUser() user: AuthUser) {
		const sessionId = await this.store.start(user.id)
		return { session_id: sessionId, expires_in: this.store.ttlSeconds }
	}

	@Public()
	@Get('me')
	@UseGuards(SessionGuard)
	async me(@Req() req: SessionRequest) {
		const session = req.activeSession as ActiveSession
		return {
			user_id: session.userId,
			expires_in: await this.store.remainingTtl(session.id),
		}
	}

	@Public()
	@Delete('me')
	@HttpCode(204)
	@UseGuards(SessionGuard)
	async end(@Req() req: SessionRequest) {
		await this.store.end((req.activeSession as ActiveSession).id)
	}
}
