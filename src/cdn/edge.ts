import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { statusOf } from '../storage/s3-client'
import { ASSET_PREFIX } from './publish-asset'

interface CachedObject {
	body: Uint8Array
	contentType: string
	cacheControl: string
	expiresAt: number
}

function freshnessMs(cacheControl: string): number {
	if (/no-store|no-cache|private/.test(cacheControl)) {
		return 0
	}
	const maxAge = /max-age=(\d+)/.exec(cacheControl)
	return maxAge ? Number(maxAge[1]) * 1000 : 0
}

function send(
	res: ServerResponse,
	object: CachedObject,
	cache: 'HIT' | 'MISS',
) {
	res
		.writeHead(200, {
			'Content-Type': object.contentType,
			'Cache-Control': object.cacheControl,
			'X-Cache': cache,
		})
		.end(object.body)
}

/**
 * The local stand-in for CloudFront + OAC: the bucket stays private and only
 * this cache reads it, with its own credentials. Anything outside assets/
 * is 404, or private uploads would leak through the cache.
 */
export function startEdge(
	s3: S3Client,
	bucket: string,
	port: number,
): Promise<Server> {
	const cache = new Map<string, CachedObject>()

	const server = createServer(async (req, res) => {
		const key = decodeURIComponent(
			new URL(req.url ?? '/', 'http://edge').pathname.slice(1),
		)
		if (req.method !== 'GET' || !key.startsWith(ASSET_PREFIX)) {
			res.writeHead(404).end()
			return
		}
		const cached = cache.get(key)
		if (cached && cached.expiresAt > Date.now()) {
			send(res, cached, 'HIT')
			return
		}
		try {
			const origin = await s3.send(
				new GetObjectCommand({ Bucket: bucket, Key: key }),
			)
			const cacheControl = origin.CacheControl ?? ''
			const ttl = freshnessMs(cacheControl)
			const object: CachedObject = {
				body: await origin.Body!.transformToByteArray(),
				contentType: origin.ContentType ?? 'application/octet-stream',
				cacheControl,
				expiresAt: Date.now() + ttl,
			}
			if (ttl > 0) {
				cache.set(key, object)
			}
			send(res, object, 'MISS')
		} catch (err) {
			res
				.writeHead(statusOf(err) === 404 ? 404 : 502, { 'X-Cache': 'MISS' })
				.end()
		}
	})

	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, '127.0.0.1', () => resolve(server))
	})
}
