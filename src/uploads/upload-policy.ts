const MiB = 1024 * 1024
const GiB = 1024 * MiB

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'application/pdf': 'pdf',
	'application/gzip': 'gz',
}

/** S3: every part except the last must be at least 5 MiB, otherwise Complete fails with EntityTooSmall. */
export const MIN_PART_BYTES = 5 * MiB
export const MAX_PARTS = 10_000
/** Fewer than two parts leaves nothing to resume: a dropped single part is a dropped file. */
export const MULTIPART_THRESHOLD_BYTES = 2 * MIN_PART_BYTES
export const MAX_UPLOAD_BYTES = 100 * GiB

export const PUT_URL_TTL_SECONDS = 300
/** Short on purpose: GET /uploads/:id/parts re-signs whatever is still missing. */
export const PART_URL_TTL_SECONDS = 900

export function extensionFor(contentType: string): string | undefined {
	return EXTENSION_BY_CONTENT_TYPE[contentType.toLowerCase()]
}

export function needsMultipart(size: number): boolean {
	return size > MULTIPART_THRESHOLD_BYTES
}

/** Rounded up to whole MiB so the 10 000-part ceiling holds for any size up to the limit. */
export function partSizeFor(size: number): number {
	const smallestFittingLimit = Math.ceil(size / MAX_PARTS / MiB) * MiB
	return Math.max(MIN_PART_BYTES, smallestFittingLimit)
}

export function partCountFor(size: number, partSize: number): number {
	return Math.ceil(size / partSize)
}
