import type { LoggerService } from '@nestjs/common'
import { logger } from './logger'

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

const nestLog = logger.child({ layer: 'nest' })

/** Nest passes the context name last and, for errors, an optional stack before it. */
export class PinoNestLogger implements LoggerService {
	log(message: unknown, ...params: unknown[]) {
		this.write('info', message, params)
	}
	error(message: unknown, ...params: unknown[]) {
		this.write('error', message, params)
	}
	warn(message: unknown, ...params: unknown[]) {
		this.write('warn', message, params)
	}
	debug(message: unknown, ...params: unknown[]) {
		this.write('debug', message, params)
	}
	verbose(message: unknown, ...params: unknown[]) {
		this.write('trace', message, params)
	}
	fatal(message: unknown, ...params: unknown[]) {
		this.write('fatal', message, params)
	}

	private write(level: Level, message: unknown, params: unknown[]) {
		const strings = params.filter((p): p is string => typeof p === 'string')
		const context = strings.length ? strings[strings.length - 1] : undefined
		const stack = strings.length > 1 ? strings[0] : undefined
		if (message instanceof Error) {
			nestLog[level]({ context, err: message }, message.message)
			return
		}
		const text = typeof message === 'string' ? message : JSON.stringify(message)
		nestLog[level]({ context, stack }, text)
	}
}
