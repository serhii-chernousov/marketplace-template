import {
	PutObjectCommand,
	UploadPartCommand,
	type S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export interface ObjectRef {
	bucket: string
	key: string
}

/** The SDK leaves Content-Type unsigned unless asked; signing it stops HTML being uploaded as an image. */
export function presignPut(
	s3: S3Client,
	{ bucket, key }: ObjectRef,
	contentType: string,
	expiresIn: number,
): Promise<string> {
	return getSignedUrl(
		s3,
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			ContentType: contentType,
		}),
		{ expiresIn, signableHeaders: new Set(['content-type']) },
	)
}

export function presignPart(
	s3: S3Client,
	{ bucket, key }: ObjectRef,
	uploadId: string,
	partNumber: number,
	expiresIn: number,
): Promise<string> {
	return getSignedUrl(
		s3,
		new UploadPartCommand({
			Bucket: bucket,
			Key: key,
			UploadId: uploadId,
			PartNumber: partNumber,
		}),
		{ expiresIn },
	)
}
