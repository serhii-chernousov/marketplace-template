import { Inject, Injectable } from '@nestjs/common'
import type Redis from 'ioredis'
import { QUEUE_REDIS } from '../redis/redis.module'
import { ACCESS_TOKEN_TTL_SEC } from './auth.constants'

/**
 * Access tokens are self-contained and live until exp, so revoking one means
 * remembering it until then. Keys expire on their own: TTL = remaining life.
 * Lives in the noeviction Redis — an evicted entry would resurrect a token.
 */
@Injectable()
export class DenyList {
	constructor(@Inject(QUEUE_REDIS) private readonly redis: Redis) {}

	async denyToken(jti: string, exp: number): Promise<void> {
		const remaining = exp - Math.floor(Date.now() / 1000)
		await this.redis.set(`deny:jti:${jti}`, '1', 'EX', Math.max(1, remaining))
	}

	/** Every access token of a family was issued less than ACCESS_TOKEN_TTL_SEC ago. */
	async denyFamily(familyId: string): Promise<void> {
		await this.redis.set(
			`deny:sid:${familyId}`,
			'1',
			'EX',
			ACCESS_TOKEN_TTL_SEC,
		)
	}

	async isDenied(jti: string, familyId: string): Promise<boolean> {
		const hits = await this.redis.exists(
			`deny:jti:${jti}`,
			`deny:sid:${familyId}`,
		)
		return hits > 0
	}
}
