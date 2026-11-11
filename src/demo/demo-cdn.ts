import { PutObjectCommand } from '@aws-sdk/client-s3'
import { startEdge } from '../cdn/edge'
import { ASSET_PREFIX, publishAsset } from '../cdn/publish-asset'
import { directObjectUrl } from '../storage/s3-client'
import { meetsExpectations, runDemo } from './auth-demo-kit'
import { printMetrics } from './print-metrics'
import { demoStorage, ensureBucket, wipePrefix } from './storage-demo-kit'

const EDGE_PORT = 3431
const STYLES_V1 = Buffer.from('body{color:#111}\n')
const STYLES_V2 = Buffer.from('body{color:#222}\n')

const EXPECTED = {
	direct: [403],
	'edge-miss': [200],
	'edge-hit': [200],
	'cache-hit': [1],
	'new-name': [1],
	'new-url': [200],
	'content-changed': [1],
	'old-url-hit': [1],
	'no-cache-control-hit': [0],
}

async function viaEdge(key: string) {
	const res = await fetch(`http://127.0.0.1:${EDGE_PORT}/${key}`)
	return {
		status: res.status,
		cache: res.headers.get('x-cache'),
		body: await res.text(),
	}
}

/**
 * The bucket is closed to the public and open to the cache. A deploy ships
 * new content under a new hashed name, so the old cache entry harms no one
 * and nothing is invalidated.
 */
runDemo(async () => {
	setTimeout(() => {
		console.error('demo timed out')
		process.exit(1)
	}, 60_000).unref()

	const storage = demoStorage()
	const { s3, bucket } = storage
	await ensureBucket(storage)
	await wipePrefix(storage, ASSET_PREFIX)
	const edge = await startEdge(s3, bucket, EDGE_PORT)
	try {
		const css = (body: Buffer) => ({
			name: 'app',
			extension: 'css',
			contentType: 'text/css',
			body,
		})
		const firstKey = await publishAsset(s3, bucket, css(STYLES_V1))

		const direct = await fetch(directObjectUrl(storage.env, firstKey))
		await direct.arrayBuffer()
		const miss = await viaEdge(firstKey)
		const hit = await viaEdge(firstKey)

		const deployedKey = await publishAsset(s3, bucket, css(STYLES_V2))
		const deployed = await viaEdge(deployedKey)
		const oldUrl = await viaEdge(firstKey)

		const mutableKey = `${ASSET_PREFIX}app.css`
		await s3.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: mutableKey,
				Body: STYLES_V1,
				ContentType: 'text/css',
			}),
		)
		await viaEdge(mutableKey)
		const uncacheable = await viaEdge(mutableKey)

		const metrics = {
			direct: direct.status,
			'edge-miss': miss.cache === 'MISS' ? miss.status : 0,
			'edge-hit': hit.status,
			'cache-hit': hit.cache === 'HIT' ? 1 : 0,
			'new-name': deployedKey !== firstKey ? 1 : 0,
			'new-url': deployed.status,
			'content-changed':
				deployed.body === STYLES_V2.toString() && deployed.body !== miss.body
					? 1
					: 0,
			'old-url-hit': oldUrl.cache === 'HIT' ? 1 : 0,
			'no-cache-control-hit': uncacheable.cache === 'HIT' ? 1 : 0,
		}
		printMetrics(metrics)
		return meetsExpectations(metrics, EXPECTED) ? 0 : 1
	} finally {
		edge.close()
	}
})
