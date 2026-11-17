import {
	AbortMultipartUploadCommand,
	CreateMultipartUploadCommand,
	type S3Client,
} from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'
import { DataSource, QueryFailedError } from 'typeorm'
import type { AuthUser } from '../auth/auth-user'
import { StoredFile } from '../entities/stored-file.entity'
import { ProblemException } from '../types/problem.exception'
import { UploadsService, type UploadIntentRequest } from './uploads.service'

jest.mock('../storage/presign', () => ({
	presignPut: jest.fn(
		async (_s3: unknown, ref: { key: string }) =>
			`https://signed.example/${ref.key}`,
	),
	presignPart: jest.fn(
		async (
			_s3: unknown,
			ref: { key: string },
			uploadId: string,
			partNumber: number,
		) =>
			`https://signed.example/${ref.key}?uploadId=${uploadId}&partNumber=${partNumber}`,
	),
}))

const OWNER: AuthUser = {
	id: '7',
	role: 'buyer',
	jti: 'jti',
	sid: 'sid',
	exp: 1,
}

const MULTIPART: UploadIntentRequest = {
	filename: 'shop-dump.sql.gz',
	content_type: 'application/gzip',
	size: 12 * 1024 * 1024,
}

const INSTANCE = '/v1/uploads/intent'

function uniqueViolation(): QueryFailedError {
	const driverError = new Error('duplicate key') as Error & { code: string }
	driverError.code = '23505'
	return new QueryFailedError('INSERT', [], driverError)
}

function harness(options?: { holdFirstMultipart?: boolean }) {
	const rows: StoredFile[] = []
	let releaseFirst: () => void = () => {}
	const bothCreating = new Promise<void>((resolve) => {
		releaseFirst = resolve
	})
	let created = 0
	const send = jest.fn(async (command: object) => {
		if (command instanceof CreateMultipartUploadCommand) {
			created += 1
			const uploadId = `upload-${created}`
			if (options?.holdFirstMultipart && created === 1) {
				await bothCreating
			} else if (options?.holdFirstMultipart) {
				releaseFirst()
			}
			return { UploadId: uploadId }
		}
		if (command instanceof AbortMultipartUploadCommand) {
			return {}
		}
		throw new Error(
			`unexpected ${(command as { constructor: { name: string } }).constructor.name}`,
		)
	})
	const repo = {
		create(data: Partial<StoredFile>): StoredFile {
			return {
				status: 'PENDING',
				uploadId: null,
				completedAt: null,
				createdAt: new Date(),
				idempotencyKey: null,
				requestHash: null,
				...data,
			} as StoredFile
		},
		async save(file: StoredFile): Promise<StoredFile> {
			const duplicate = rows.find(
				(row) =>
					row !== file &&
					row.ownerId === file.ownerId &&
					row.idempotencyKey !== null &&
					row.idempotencyKey === file.idempotencyKey,
			)
			if (duplicate) {
				throw uniqueViolation()
			}
			if (!file.id) {
				file.id = randomUUID()
			}
			if (!rows.includes(file)) {
				rows.push(file)
			}
			return file
		},
		async findOneBy(
			where: Partial<Pick<StoredFile, 'id' | 'ownerId' | 'idempotencyKey'>>,
		): Promise<StoredFile | null> {
			return (
				rows.find(
					(row) =>
						(where.id === undefined || row.id === where.id) &&
						(where.ownerId === undefined || row.ownerId === where.ownerId) &&
						(where.idempotencyKey === undefined ||
							row.idempotencyKey === where.idempotencyKey),
				) ?? null
			)
		},
	}
	const dataSource = {
		getRepository: () => repo,
	} as unknown as DataSource
	return {
		rows,
		send,
		service: new UploadsService(
			dataSource,
			{ send } as unknown as S3Client,
			'bucket',
		),
	}
}

function multipartCalls(send: jest.Mock): number {
	return send.mock.calls.filter(
		([command]) => command instanceof CreateMultipartUploadCommand,
	).length
}

function abortedUploadIds(send: jest.Mock): string[] {
	return send.mock.calls
		.map(([command]) => command)
		.filter(
			(command): command is AbortMultipartUploadCommand =>
				command instanceof AbortMultipartUploadCommand,
		)
		.map((command) => command.input.UploadId ?? '')
}

describe('UploadsService.createIntent', () => {
	it('reuses one pending multipart when the same Idempotency-Key is repeated', async () => {
		const { service, rows, send } = harness()

		const first = await service.createIntent(
			OWNER,
			MULTIPART,
			INSTANCE,
			'tap-1',
		)
		const second = await service.createIntent(
			OWNER,
			MULTIPART,
			INSTANCE,
			'tap-1',
		)

		expect(first.replay).toBe(false)
		expect(second.replay).toBe(true)
		expect(second.intent.id).toBe(first.intent.id)
		expect(second.intent).toMatchObject({
			mode: 'multipart',
			key: first.intent.key,
			part_count: 3,
		})
		if (
			second.intent.mode === 'multipart' &&
			first.intent.mode === 'multipart'
		) {
			expect(second.intent.parts[0]?.url).toContain(
				`uploadId=${rows[0]?.uploadId}`,
			)
			expect(second.intent.parts).toHaveLength(first.intent.parts.length)
		}
		expect(rows).toHaveLength(1)
		expect(rows[0]?.status).toBe('PENDING')
		expect(multipartCalls(send)).toBe(1)
		expect(abortedUploadIds(send)).toEqual([])
	})

	it('rejects the same Idempotency-Key when the body differs', async () => {
		const { service, rows, send } = harness()
		await service.createIntent(OWNER, MULTIPART, INSTANCE, 'tap-1')

		const conflict = service.createIntent(
			OWNER,
			{ ...MULTIPART, size: MULTIPART.size + 1 },
			INSTANCE,
			'tap-1',
		)

		await expect(conflict).rejects.toBeInstanceOf(ProblemException)
		await expect(conflict).rejects.toMatchObject({ status: 422 })
		expect(rows).toHaveLength(1)
		expect(multipartCalls(send)).toBe(1)
	})

	it('aborts the spare multipart when two intents with one key overlap', async () => {
		const { service, rows, send } = harness({ holdFirstMultipart: true })

		const [left, right] = await Promise.all([
			service.createIntent(OWNER, MULTIPART, INSTANCE, 'tap-1'),
			service.createIntent(OWNER, MULTIPART, INSTANCE, 'tap-1'),
		])

		expect(left.intent.id).toBe(right.intent.id)
		expect(rows).toHaveLength(1)
		expect(multipartCalls(send)).toBe(2)
		expect(abortedUploadIds(send)).toEqual([
			expect.not.stringMatching(rows[0]?.uploadId ?? ''),
		])
		expect(abortedUploadIds(send)[0]).not.toBe(rows[0]?.uploadId)
	})
})
