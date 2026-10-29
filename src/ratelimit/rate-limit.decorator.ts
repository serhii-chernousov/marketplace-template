import { Reflector } from '@nestjs/core'
import type { RateLimitPolicy } from './sliding-window-limiter'

export const RateLimit = Reflector.createDecorator<RateLimitPolicy>()
