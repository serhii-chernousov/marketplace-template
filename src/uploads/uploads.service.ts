import {
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	HeadObjectCommand,
	ListPartsCommand,
	type HeadObjectCommandOutput,
	type Part,
	type S3Client,
} from '@aws-sdk/client-s3'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import type { AuthUser } from '../auth/auth-user'
import { forbidden } from '../auth/problems'
import { StoredFile } from '../entities/stored-file.entity'
import { presignPart, presignPut, type ObjectRef } from '../storage/presign'
import { statusOf } from '../storage/s3-client'
import { S3_CLIENT, STORAGE_BUCKET } from '../storage/storage.module'
import {
	MAX_UPLOAD_BYTES,
	PART_URL_TTL_SECONDS,
	PUT_URL_TTL_SECONDS,
	extensionFor,
	needsMultipart,
	partCountFor,
	partSizeFor,
} from './upload-policy'
import { fileNotFound, invalidUpload, uploadConflict } from './upload-problems'

export interface UploadIntentRequest {
	filename: string
	content_type: string
	size: number
}

export interface PresignedPart {
	part_number: number
	url: string
}

export type UploadIntent =
	| {
			id: string
			key: string
			mode: 'single'
			method: 'PUT'
			url: string
			headers: Record<string, string>
			expires_in: number
	  }
	| {
			id: string
			key: string
			mode: 'multipart'
			part_size: number
			part_count: number
			parts: PresignedPart[]
			expires_in: number
	  }

export interface UploadParts {
	id: string
	part_size: number
	part_count: number
	uploaded: number[]
	missing: PresignedPart[]
	expires_in: number
}

export interface CommittedFile {
	id: string
	key: string
	size: number
	status: 'COMPLETED'
	etag: string
}

const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)

/**
 * The API stays on the authorization path but off the data path: it signs
 * URLs and checks results, the bytes go straight to the bucket. Presigned
 * URLs are bearer credentials, so only fileId and key reach the log.
 */
@Injectable()
export class UploadsService {
	private readonly logger = new Logger(UploadsService.name)

	constructor(
		private readonly dataSource: DataSource,
		@Inject(S3_CLIENT) private readonly s3: S3Client,
		@Inject(STORAGE_BUCKET) private readonly bucket: string,
	) {}

	async createIntent(
		owner: AuthUser,
		request: UploadIntentRequest,
		instance: string,
	): Promise<UploadIntent> {
		const extension = extensionFor(request.content_type)
		if (!extension) {
			throw invalidUpload(
				`Content type ${request.content_type} is not allowed`,
				instance,
			)
		}
		if (request.size > MAX_UPLOAD_BYTES) {
			throw invalidUpload(
				`File is larger than ${MAX_UPLOAD_BYTES} bytes`,
				instance,
			)
		}
		const contentType = request.content_type.toLowerCase()
		const ref = this.ref(`uploads/${owner.id}/${randomUUID()}.${extension}`)

		if (!needsMultipart(request.size)) {
			const file = await this.files().save(
				this.files().create({
					ownerId: owner.id,
					key: ref.key,
					contentType,
					size: String(request.size),
				}),
			)
			this.logger.log(`upload intent fileId=${file.id} key=${ref.key} single`)
			return {
				id: file.id,
				key: ref.key,
				mode: 'single',
				method: 'PUT',
				url: await presignPut(this.s3, ref, contentType, PUT_URL_TTL_SECONDS),
				headers: { 'Content-Type': contentType },
				expires_in: PUT_URL_TTL_SECONDS,
			}
		}

		const { UploadId } = await this.s3.send(
			new CreateMultipartUploadCommand({
				Bucket: ref.bucket,
				Key: ref.key,
				ContentType: contentType,
			}),
		)
		const file = await this.files().save(
			this.files().create({
				ownerId: owner.id,
				key: ref.key,
				contentType,
				size: String(request.size),
				uploadId: UploadId ?? null,
			}),
		)
		const partSize = partSizeFor(request.size)
		const partCount = partCountFor(request.size, partSize)
		this.logger.log(
			`upload intent fileId=${file.id} key=${ref.key} multipart parts=${partCount}`,
		)
		return {
			id: file.id,
			key: ref.key,
			mode: 'multipart',
			part_size: partSize,
			part_count: partCount,
			parts: await this.presignParts(file, range(partCount)),
			expires_in: PART_URL_TTL_SECONDS,
		}
	}

	async uploadParts(
		owner: AuthUser,
		id: string,
		instance: string,
	): Promise<UploadParts> {
		const file = await this.loadOwned(owner, id, instance)
		if (!file.uploadId || file.status !== 'PENDING') {
			throw uploadConflict(
				'File is not an unfinished multipart upload',
				instance,
			)
		}
		const size = Number(file.size)
		const partSize = partSizeFor(size)
		const partCount = partCountFor(size, partSize)
		const uploaded = (await this.listParts(file)).map((p) => p.PartNumber!)
		const missing = range(partCount).filter((n) => !uploaded.includes(n))
		return {
			id: file.id,
			part_size: partSize,
			part_count: partCount,
			uploaded,
			missing: await this.presignParts(file, missing),
			expires_in: PART_URL_TTL_SECONDS,
		}
	}

	async commit(
		owner: AuthUser,
		id: string,
		instance: string,
	): Promise<CommittedFile> {
		const file = await this.loadOwned(owner, id, instance)
		if (file.status === 'PENDING' && file.uploadId) {
			await this.completeMultipart(file, instance)
		}
		const head = await this.headOrConflict(file, instance)
		if (head.ContentLength !== Number(file.size)) {
			throw uploadConflict(
				`Stored object has ${head.ContentLength} bytes, expected ${file.size}`,
				instance,
			)
		}
		if (file.status === 'PENDING') {
			file.status = 'COMPLETED'
			file.completedAt = new Date()
			await this.files().save(file)
			this.logger.log(`upload committed fileId=${file.id} key=${file.key}`)
		}
		return {
			id: file.id,
			key: file.key,
			size: Number(file.size),
			status: 'COMPLETED',
			etag: head.ETag ?? '',
		}
	}

	/** Parts come from ListParts, not from the client: a browser cannot even read ETag without CORS ExposeHeaders. */
	private async completeMultipart(
		file: StoredFile,
		instance: string,
	): Promise<void> {
		const size = Number(file.size)
		const partCount = partCountFor(size, partSizeFor(size))
		let parts: Part[]
		try {
			parts = await this.listParts(file)
		} catch (err) {
			if (statusOf(err) === 404) {
				return
			}
			throw err
		}
		if (parts.length < partCount) {
			throw uploadConflict(
				`${parts.length} of ${partCount} parts uploaded`,
				instance,
			)
		}
		try {
			await this.s3.send(
				new CompleteMultipartUploadCommand({
					Bucket: this.bucket,
					Key: file.key,
					UploadId: file.uploadId!,
					MultipartUpload: {
						Parts: parts.map((p) => ({
							PartNumber: p.PartNumber,
							ETag: p.ETag,
						})),
					},
				}),
			)
		} catch (err) {
			if (statusOf(err) === 400) {
				throw uploadConflict(
					`Storage rejected the parts: ${(err as Error).name}`,
					instance,
				)
			}
			throw err
		}
	}

	private async listParts(file: StoredFile): Promise<Part[]> {
		const parts: Part[] = []
		let marker: string | undefined
		do {
			const page = await this.s3.send(
				new ListPartsCommand({
					Bucket: this.bucket,
					Key: file.key,
					UploadId: file.uploadId!,
					PartNumberMarker: marker,
				}),
			)
			parts.push(...(page.Parts ?? []))
			marker = page.IsTruncated ? page.NextPartNumberMarker : undefined
		} while (marker)
		return parts
	}

	private async headOrConflict(
		file: StoredFile,
		instance: string,
	): Promise<HeadObjectCommandOutput> {
		try {
			return await this.s3.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: file.key }),
			)
		} catch (err) {
			if (statusOf(err) === 404) {
				throw uploadConflict('Object has not been uploaded yet', instance)
			}
			throw err
		}
	}

	private presignParts(
		file: StoredFile,
		partNumbers: number[],
	): Promise<PresignedPart[]> {
		const ref = this.ref(file.key)
		return Promise.all(
			partNumbers.map(async (partNumber) => ({
				part_number: partNumber,
				url: await presignPart(
					this.s3,
					ref,
					file.uploadId!,
					partNumber,
					PART_URL_TTL_SECONDS,
				),
			})),
		)
	}

	private async loadOwned(
		owner: AuthUser,
		id: string,
		instance: string,
	): Promise<StoredFile> {
		const file = await this.files().findOneBy({ id })
		if (!file) {
			throw fileNotFound(instance)
		}
		if (file.ownerId !== owner.id) {
			throw forbidden('File belongs to another user', instance)
		}
		return file
	}

	private ref(key: string): ObjectRef {
		return { bucket: this.bucket, key }
	}

	private files() {
		return this.dataSource.getRepository(StoredFile)
	}
}
