import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'

export const ASSET_PREFIX = 'assets/'
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

export interface Asset {
	name: string
	extension: string
	contentType: string
	body: Buffer
}

/**
 * New content gets a new URL, so a cached old copy never has to be purged.
 * Cache-Control rides on the object itself: an edge only caches what origin allows.
 */
export async function publishAsset(
	s3: S3Client,
	bucket: string,
	asset: Asset,
): Promise<string> {
	const hash = createHash('sha256').update(asset.body).digest('hex').slice(0, 8)
	const key = `${ASSET_PREFIX}${asset.name}.${hash}.${asset.extension}`
	await s3.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: asset.body,
			ContentType: asset.contentType,
			CacheControl: IMMUTABLE_CACHE_CONTROL,
		}),
	)
	return key
}
