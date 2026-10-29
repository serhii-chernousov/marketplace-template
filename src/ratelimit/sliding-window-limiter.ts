import type Redis from 'ioredis'

/**
 * One script: ZREMRANGEBYSCORE, ZCARD, and ZADD share a lock.
 * Three separate commands let a second pod slip in between the count
 * and the add, which is exactly when the limit matters.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)
if count < limit then
	redis.call('ZADD', key, now, member)
	redis.call('PEXPIRE', key, windowMs)
	return {1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retryAfter = 1
if oldest[2] ~= nil then
	local waitMs = tonumber(oldest[2]) + windowMs - now
	if waitMs > 0 then
		retryAfter = math.ceil(waitMs / 1000)
	end
end
if retryAfter < 1 then
	retryAfter = 1
end
return {0, retryAfter}
`

export interface RateLimitPolicy {
	limit: number
	windowMs: number
}

export interface LimitResponse {
	allowed: boolean
	status: number
	headers: Record<string, string>
}

/**
 * Sliding window on a shared Redis key.
 * A fixed window allows 2× the limit across the boundary
 * (5 at 12:00:59 and 5 at 12:01:00). This model does not.
 */
export class SlidingWindowLimiter {
	constructor(private readonly redis: Redis) {}

	async consume(
		bucket: string,
		policy: RateLimitPolicy,
	): Promise<LimitResponse> {
		const member = `${Date.now()}-${Math.random().toString(16).slice(2)}`
		const raw = (await this.redis.eval(
			SLIDING_WINDOW_LUA,
			1,
			`rl:${bucket}`,
			String(Date.now()),
			String(policy.windowMs),
			String(policy.limit),
			member,
		)) as [number, number]
		if (Number(raw[0]) === 1) {
			return { allowed: true, status: 200, headers: {} }
		}
		const retryAfter = Math.max(1, Number(raw[1]))
		return {
			allowed: false,
			status: 429,
			headers: { 'Retry-After': String(retryAfter) },
		}
	}
}
