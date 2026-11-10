import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sleep } from '../common/sleep'
import { presignPut } from '../storage/presign'
import {
	meetsExpectations,
	resetDemoAccounts,
	runDemo,
	startDemoApp,
	type DemoApp,
} from './auth-demo-kit'
import { printMetrics } from './print-metrics'
import {
	demoStorage,
	isPortOpen,
	readMetric,
	resetOwnerFiles,
	runChild,
} from './storage-demo-kit'

const PORT = 3421
/** fetch keeps a pool per (host, port); a restart on the same port could get a dead socket from it. */
const RESTART_PORT = 3422
const CONTENT_TYPE = 'image/png'
const AVATAR = Buffer.concat([
	Buffer.from('89504e470d0a1a0a', 'hex'),
	Buffer.alloc(4096, 0x2a),
])

const EXPECTED = {
	intent: [200],
	'key-from-server': [1],
	'api-alive': [0],
	'put-offline': [200],
	'offline-credential-vars': [0],
	commit: [200],
	'commit-without-bytes': [409],
	tampered: [403],
	expired: [403],
}

async function put(url: string): Promise<number> {
	const res = await fetch(url, {
		method: 'PUT',
		headers: { 'Content-Type': CONTENT_TYPE },
		body: AVATAR,
	})
	await res.arrayBuffer()
	return res.status
}

function withKey(url: string, key: string, otherKey: string): string {
	const tampered = new URL(url)
	tampered.pathname = tampered.pathname.replace(key, otherKey)
	return tampered.toString()
}

/**
 * Bytes travel past the API: the app is stopped before the PUT, and the PUT
 * runs in a process that holds no storage key. Commit then refuses anything
 * HeadObject cannot see; the signature covers the key and dies on time.
 */
runDemo(async () => {
	const storage = demoStorage()
	const workDir = mkdtempSync(join(tmpdir(), 'demo-upload-'))
	const avatarPath = join(workDir, 'avatar.png')
	writeFileSync(avatarPath, AVATAR)

	let first: DemoApp | undefined = await startDemoApp(PORT)
	let second: DemoApp | undefined
	try {
		const [owner] = await resetDemoAccounts(first.dataSource, [
			{ email: 'demo-upload@shop.local', role: 'buyer' },
		])
		await resetOwnerFiles(storage, first.dataSource, owner.id)
		const login = await first.call('POST', '/v1/auth/login', {
			body: { email: owner.email, password: owner.password },
		})
		const token = String(login.body.access_token)
		const newIntent = (app: DemoApp) =>
			app.call('POST', '/v1/uploads/intent', {
				token,
				body: {
					filename: '../../etc/passwd',
					content_type: CONTENT_TYPE,
					size: AVATAR.length,
				},
			})

		const intent = await newIntent(first)
		const key = String(intent.body.key)
		const url = String(intent.body.url)
		const keyFromServer =
			new RegExp(`^uploads/${owner.id}/[0-9a-f-]{36}\\.png$`).test(key) &&
			!key.includes('passwd') &&
			!key.includes('..')

		const tampered = await put(
			withKey(url, key, `uploads/${owner.id}/${randomUUID()}.png`),
		)

		const unfilled = await newIntent(first)
		const commitWithoutBytes = await first.call(
			'POST',
			`/v1/uploads/${String(unfilled.body.id)}/commit`,
			{ token },
		)

		await first.app.close()
		first = undefined
		const apiAlive = await isPortOpen(PORT)

		const offline = await runChild(
			join(__dirname, 'offline-put.js'),
			{ url, contentType: CONTENT_TYPE, filePath: avatarPath },
			{ PATH: process.env.PATH },
		)

		second = await startDemoApp(RESTART_PORT)
		const commit = await second.call(
			'POST',
			`/v1/uploads/${String(intent.body.id)}/commit`,
			{ token },
		)

		const shortLived = await presignPut(
			storage.s3,
			{
				bucket: storage.bucket,
				key: `uploads/${owner.id}/${randomUUID()}.png`,
			},
			CONTENT_TYPE,
			1,
		)
		await sleep(3000)
		const expired = await put(shortLived)

		const metrics = {
			intent: intent.status,
			'key-from-server': keyFromServer ? 1 : 0,
			tampered,
			'commit-without-bytes': commitWithoutBytes.status,
			'api-alive': apiAlive ? 1 : 0,
			'put-offline': readMetric(offline.stdout, 'status'),
			'offline-credential-vars': readMetric(offline.stdout, 'credential-vars'),
			commit: commit.status,
			expired,
		}
		printMetrics(metrics)
		return meetsExpectations(metrics, EXPECTED) ? 0 : 1
	} finally {
		await first?.app.close()
		await second?.app.close()
		rmSync(workDir, { recursive: true, force: true })
	}
})
