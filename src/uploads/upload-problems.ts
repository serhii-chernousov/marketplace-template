import { ProblemException } from '../types/problem.exception'

export const invalidUpload = (detail: string, instance: string) =>
	new ProblemException(
		400,
		'https://marketplace.local/problems/invalid-upload',
		'Invalid upload',
		detail,
		instance,
	)

export const fileNotFound = (instance: string) =>
	new ProblemException(
		404,
		'https://marketplace.local/problems/file-not-found',
		'File not found',
		'File with the given id does not exist',
		instance,
	)

export const uploadConflict = (detail: string, instance: string) =>
	new ProblemException(
		409,
		'https://marketplace.local/problems/upload-conflict',
		'Upload conflict',
		detail,
		instance,
	)
