import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env.schema'
import { sleep } from './sleep'

const MAX_DELAY_MS = 3000

export interface Fault {
	fail: boolean
	delayMs: number
}

/**
 * Off unless FAULT_INJECTION=1: lets demos produce a real 5xx or a slow
 * response on a business route instead of a fake endpoint.
 */
@Injectable()
export class FaultInjection {
	private readonly enabled: boolean

	constructor(config: ConfigService<Env, true>) {
		this.enabled = config.get('FAULT_INJECTION', { infer: true }) === '1'
	}

	read(failHeader?: string, delayHeader?: string): Fault {
		if (!this.enabled) {
			return { fail: false, delayMs: 0 }
		}
		const delayMs = Math.min(
			Math.max(Number(delayHeader) || 0, 0),
			MAX_DELAY_MS,
		)
		return { fail: failHeader === '500', delayMs }
	}

	async apply(fault: Fault): Promise<void> {
		if (fault.delayMs) {
			await sleep(fault.delayMs)
		}
		if (fault.fail) {
			throw new Error('injected fault')
		}
	}
}
