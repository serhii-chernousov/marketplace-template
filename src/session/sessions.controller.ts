import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Post,
	Req,
	UseGuards,
} from '@nestjs/common'
import { RateLimit } from '../ratelimit/rate-limit.decorator'
import { SessionStore } from './session-store'
import { SessionGuard } from './session.guard'
import type { ActiveSession, SessionRequest } from './session.middleware'

/** Until real auth lands, a session is issued for the claimed user id. */
@Controller('v1/sessions')
export class SessionsController {
	constructor(private readonly store: SessionStore) {}

	@Post()
	@HttpCode(201)
	@RateLimit({ limit: 5, windowMs: 60_000 })
	async create(@Body() body: { user_id: string }) {
		const sessionId = await this.store.start(body.user_id)
		return { session_id: sessionId, expires_in: this.store.ttlSeconds }
	}

	@Get('me')
	@UseGuards(SessionGuard)
	async me(@Req() req: SessionRequest) {
		const session = req.activeSession as ActiveSession
		return {
			user_id: session.userId,
			expires_in: await this.store.remainingTtl(session.id),
		}
	}

	@Delete('me')
	@HttpCode(204)
	@UseGuards(SessionGuard)
	async end(@Req() req: SessionRequest) {
		await this.store.end((req.activeSession as ActiveSession).id)
	}
}
