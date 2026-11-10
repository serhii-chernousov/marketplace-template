import {
	AbortMultipartUploadCommand,
	CreateBucketCommand,
	DeleteObjectsCommand,
	HeadBucketCommand,
	ListMultipartUploadsCommand,
	ListObjectsV2Command,
	type S3Client,
} from '@aws-sdk/client-s3'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import type { DataSource } from 'typeorm'
import type { StorageEnv } from '../config/env.schema'
import { createS3Client, statusOf, storageEnvFrom } from '../storage/s3-client'

export interface DemoStorage {
	env: StorageEnv
	s3: S3Client
	bucket: string
}

export function demoStorage(): DemoStorage {
	const env = storageEnvFrom(process.env)
	return { env, s3: createS3Client(env), bucket: env.STORAGE_BUCKET }
}

export async function ensureBucket({ s3, bucket }: DemoStorage): Promise<void> {
	try {
		await s3.send(new HeadBucketCommand({ Bucket: bucket }))
	} catch (err) {
		if (statusOf(err) !== 404) {
			throw err
		}
		await s3.send(new CreateBucketCommand({ Bucket: bucket }))
	}
}

export async function wipePrefix(
	{ s3, bucket }: DemoStorage,
	prefix: string,
): Promise<void> {
	let token: string | undefined
	do {
		const page = await s3.send(
			new ListObjectsV2Command({
				Bucket: bucket,
				Prefix: prefix,
				ContinuationToken: token,
			}),
		)
		const objects = (page.Contents ?? []).map(({ Key }) => ({ Key }))
		if (objects.length > 0) {
			await s3.send(
				new DeleteObjectsCommand({
					Bucket: bucket,
					Delete: { Objects: objects },
				}),
			)
		}
		token = page.IsTruncated ? page.NextContinuationToken : undefined
	} while (token)
}

/**
 * Unfinished multipart uploads are invisible to object listings and keep
 * being billed. The rows are the reliable index; the storage listing is a
 * safety net because MinIO may only list uploads for an exact key.
 */
export async function abortUnfinishedUploads(
	storage: DemoStorage,
	dataSource: DataSource,
	ownerId: string,
): Promise<void> {
	const { s3, bucket } = storage
	const rows: Array<{ key: string; upload_id: string }> =
		await dataSource.query(
			`SELECT key, upload_id FROM files WHERE owner_id = $1 AND upload_id IS NOT NULL`,
			[ownerId],
		)
	const listed = await s3.send(
		new ListMultipartUploadsCommand({
			Bucket: bucket,
			Prefix: `uploads/${ownerId}/`,
		}),
	)
	const uploads = [
		...rows.map((r) => ({ Key: r.key, UploadId: r.upload_id })),
		...(listed.Uploads ?? []).map(({ Key, UploadId }) => ({ Key, UploadId })),
	]
	for (const { Key, UploadId } of uploads) {
		try {
			await s3.send(
				new AbortMultipartUploadCommand({ Bucket: bucket, Key, UploadId }),
			)
		} catch (err) {
			if (statusOf(err) !== 404) {
				throw err
			}
		}
	}
}

export async function resetOwnerFiles(
	storage: DemoStorage,
	dataSource: DataSource,
	ownerId: string,
): Promise<void> {
	await ensureBucket(storage)
	await abortUnfinishedUploads(storage, dataSource, ownerId)
	await wipePrefix(storage, `uploads/${ownerId}/`)
	await dataSource.query(`DELETE FROM files WHERE owner_id = $1`, [ownerId])
}

/** A raw socket, not fetch: fetch's keep-alive pool could hand back a socket to the dead server. */
export function isPortOpen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, '127.0.0.1')
		socket.once('connect', () => {
			socket.destroy()
			resolve(true)
		})
		socket.once('error', () => resolve(false))
	})
}

export interface ChildResult {
	code: number | null
	signal: NodeJS.Signals | null
	stdout: string
}

/** Input goes over stdin: a presigned URL in argv would be visible to anyone running ps. */
export function runChild(
	script: string,
	input: unknown,
	env: NodeJS.ProcessEnv,
): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script], {
			env,
			stdio: ['pipe', 'pipe', 'inherit'],
		})
		const killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000)
		let stdout = ''
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			clearTimeout(killTimer)
			resolve({ code, signal, stdout })
		})
		child.stdin.end(JSON.stringify(input))
	})
}

export function readMetric(stdout: string, key: string): number {
	const line = stdout.split('\n').find((l) => l.startsWith(`${key}=`))
	return line ? Number(line.slice(key.length + 1)) : 0
}
