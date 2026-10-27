import { Injectable, NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { SessionStore, type SessionRecord } from './session-store'

export const SESSION_HEADER = 'x-session-id'

export interface ActiveSession extends SessionRecord {
	id: string
}

export type SessionRequest = Request & { activeSession?: ActiveSession }

/**
 * Every request with a session header renews the TTL, so an active
 * user is never logged out mid-work. A missing or expired session is
 * not an error here; SessionGuard decides which routes need one.
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
	constructor(private readonly store: SessionStore) {}

	async use(req: SessionRequest, _res: Response, next: NextFunction) {
		const sessionId = req.header(SESSION_HEADER)
		if (sessionId) {
			const record = await this.store.touch(sessionId)
			if (record) {
				req.activeSession = { id: sessionId, ...record }
			}
		}
		next()
	}
}
