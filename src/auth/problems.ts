import { ProblemException } from '../types/problem.exception'

export const unauthorized = (detail: string, instance: string) =>
	new ProblemException(
		401,
		'https://marketplace.local/problems/unauthorized',
		'Unauthorized',
		detail,
		instance,
	)

export const forbidden = (detail: string, instance: string) =>
	new ProblemException(
		403,
		'https://marketplace.local/problems/forbidden',
		'Forbidden',
		detail,
		instance,
	)
