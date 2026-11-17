import { Injectable } from '@nestjs/common'

/** Whether this pod should receive traffic. Never consults DB or Redis. */
@Injectable()
export class ReadinessState {
	private ready = false

	isReady(): boolean {
		return this.ready
	}

	markReady(): void {
		this.ready = true
	}

	markNotReady(): void {
		this.ready = false
	}
}
