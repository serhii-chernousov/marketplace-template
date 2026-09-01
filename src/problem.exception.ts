export interface ProblemBody {
	type: string
	title: string
	status: number
	detail: string
	instance: string
}

export class ProblemException extends Error {
	readonly status: number
	readonly body: ProblemBody

	constructor(
		status: number,
		type: string,
		title: string,
		detail: string,
		instance: string,
	) {
		super(detail)
		this.status = status
		this.body = { type, title, status, detail, instance }
	}
}
