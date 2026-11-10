import { S3Client } from '@aws-sdk/client-s3'
import { storageEnvSchema, type StorageEnv } from '../config/env.schema'

export function createS3Client(env: StorageEnv): S3Client {
	return new S3Client({
		region: env.STORAGE_REGION,
		endpoint: env.STORAGE_ENDPOINT || undefined,
		forcePathStyle: Boolean(env.STORAGE_ENDPOINT),
		credentials: {
			accessKeyId: env.STORAGE_ACCESS_KEY,
			secretAccessKey: env.STORAGE_SECRET_KEY,
		},
		// A presigned URL is signed before the body exists, so a default CRC32 would be the checksum of nothing.
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED',
	})
}

export function storageEnvFrom(raw: Record<string, unknown>): StorageEnv {
	return storageEnvSchema.parse(raw)
}

export function statusOf(err: unknown): number | undefined {
	return (err as { $metadata?: { httpStatusCode?: number } }).$metadata
		?.httpStatusCode
}

/** Anonymous URL straight into the bucket, bypassing every cache layer. */
export function directObjectUrl(env: StorageEnv, key: string): string {
	const path = key.split('/').map(encodeURIComponent).join('/')
	if (env.STORAGE_ENDPOINT) {
		return `${env.STORAGE_ENDPOINT.replace(/\/$/, '')}/${env.STORAGE_BUCKET}/${path}`
	}
	return `https://${env.STORAGE_BUCKET}.s3.${env.STORAGE_REGION}.amazonaws.com/${path}`
}
