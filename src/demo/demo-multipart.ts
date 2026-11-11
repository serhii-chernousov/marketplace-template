import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statusOf } from '../storage/s3-client'
import {
	meetsExpectations,
	resetDemoAccounts,
	runDemo,
	startDemoApp,
} from './auth-demo-kit'
import { printMetrics } from './print-metrics'
import {
	demoStorage,
	readMetric,
	resetOwnerFiles,
	runChild,
	type DemoStorage,
} from './storage-demo-kit'

const PORT = 3423
const FILE_SIZE = 12 * 1024 * 1024
const CRASH_AFTER_PARTS = 2

const EXPECTED = {
	'part-count': [3],
	crashed: [1],
	'resumed-parts': [1],
	'head-before-complete': [404],
	complete: [200],
	'size-match': [1],
	'etag-multipart': [1],
}

/** Same bytes every run, so the ETag and every printed number are stable. */
function deterministicFile(size: number): Buffer {
	const file = Buffer.alloc(size)
	for (let i = 0; i < size; i++) {
		file[i] = (i * 31 + (i >>> 13)) & 0xff
	}
	return file
}

async function headStatus({ s3, bucket }: DemoStorage, key: string) {
	try {
		await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
		return 200
	} catch (err) {
		return statusOf(err) ?? 0
	}
}

/**
 * Multipart as resumption: the first uploader dies after two of three parts,
 * a fresh process asks the API (ListParts) what is already stored and sends
 * only the rest. The object does not exist until Complete.
 */
runDemo(async () => {
	const storage = demoStorage()
	const workDir = mkdtempSync(join(tmpdir(), 'demo-multipart-'))
	const { app, dataSource, call } = await startDemoApp(PORT)
	try {
		const [owner] = await resetDemoAccounts(dataSource, [
			{ email: 'demo-multipart@shop.local', role: 'buyer' },
		])
		await resetOwnerFiles(storage, dataSource, owner.id)
		const login = await call('POST', '/v1/auth/login', {
			body: { email: owner.email, password: owner.password },
		})
		const token = String(login.body.access_token)

		const file = deterministicFile(FILE_SIZE)
		const filePath = join(workDir, 'shop-dump.sql.gz')
		writeFileSync(filePath, file)
		const md5 = createHash('md5').update(file).digest('hex')

		const intent = await call('POST', '/v1/uploads/intent', {
			token,
			body: {
				filename: 'shop-dump.sql.gz',
				content_type: 'application/gzip',
				size: FILE_SIZE,
			},
		})
		if (intent.status !== 200 || intent.body.mode !== 'multipart') {
			throw new Error(
				`intent answered ${intent.status} ${String(intent.body.mode)}`,
			)
		}
		const fileId = String(intent.body.id)
		const key = String(intent.body.key)
		const partCount = Number(intent.body.part_count)

		const uploader = join(__dirname, 'part-uploader.js')
		const uploaderInput = {
			apiBase: `http://127.0.0.1:${PORT}`,
			token,
			fileId,
			filePath,
		}
		const childEnv = { PATH: process.env.PATH }
		const crashed = await runChild(
			uploader,
			{ ...uploaderInput, crashAfter: CRASH_AFTER_PARTS },
			childEnv,
		)
		const resumed = await runChild(uploader, uploaderInput, childEnv)

		const headBeforeComplete = await headStatus(storage, key)
		const commit = await call('POST', `/v1/uploads/${fileId}/commit`, { token })
		const head = await storage.s3.send(
			new HeadObjectCommand({ Bucket: storage.bucket, Key: key }),
		)
		const etag = (head.ETag ?? '').replace(/"/g, '')

		const metrics = {
			'part-count': partCount,
			crashed: crashed.signal === 'SIGKILL' ? 1 : 0,
			'resumed-parts': readMetric(resumed.stdout, 'uploaded'),
			'head-before-complete': headBeforeComplete,
			complete: commit.status,
			'size-match': head.ContentLength === FILE_SIZE ? 1 : 0,
			'etag-multipart': etag.endsWith(`-${partCount}`) && etag !== md5 ? 1 : 0,
		}
		printMetrics(metrics)
		return meetsExpectations(metrics, EXPECTED) ? 0 : 1
	} finally {
		await app.close()
		rmSync(workDir, { recursive: true, force: true })
	}
})
