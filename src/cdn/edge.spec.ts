import type { S3Client } from '@aws-sdk/client-s3'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { ASSET_PREFIX } from './publish-asset'
import { startEdge } from './edge'

const BODY = Uint8Array.from([1, 2, 3, 4])
const CACHE_CONTROL = 'public, max-age=60'
const KEY = `${ASSET_PREFIX}app.abcd1234.css`

function origin() {
	const send = jest.fn(async (command: unknown) => {
		if (!(command instanceof GetObjectCommand)) {
			throw new Error('unexpected command')
		}
		return {
			Body: { transformToByteArray: async () => BODY },
			ContentType: 'text/css',
			CacheControl: CACHE_CONTROL,
		}
	})
	return { s3: { send } as unknown as S3Client, send }
}

async function listen(): Promise<{
	server: Server
	base: string
	send: jest.Mock
}> {
	const { s3, send } = origin()
	const server = await startEdge(s3, 'bucket', 0)
	const { port } = server.address() as AddressInfo
	return { server, base: `http://127.0.0.1:${port}`, send }
}

describe('edge', () => {
	let server: Server

	afterEach(
		() =>
			new Promise<void>((resolve, reject) => {
				if (!server) {
					resolve()
					return
				}
				server.close((err) => (err ? reject(err) : resolve()))
			}),
	)

	it('answers HEAD with the same headers as a cached GET and an empty body', async () => {
		const started = await listen()
		server = started.server
		const hit = await fetch(`${started.base}/${KEY}`)
		expect(hit.status).toBe(200)
		expect(hit.headers.get('x-cache')).toBe('MISS')
		expect(Buffer.from(await hit.arrayBuffer())).toEqual(Buffer.from(BODY))
		const again = await fetch(`${started.base}/${KEY}`)
		expect(again.headers.get('x-cache')).toBe('HIT')
		await again.arrayBuffer()

		const head = await fetch(`${started.base}/${KEY}`, { method: 'HEAD' })

		expect(head.status).toBe(200)
		expect(head.headers.get('content-type')).toBe('text/css')
		expect(head.headers.get('cache-control')).toBe(CACHE_CONTROL)
		expect(head.headers.get('x-cache')).toBe('HIT')
		expect(head.headers.get('content-length')).toBe(String(BODY.byteLength))
		expect(await head.text()).toBe('')
		expect(started.send).toHaveBeenCalledTimes(1)
	})

	it('fills the cache on HEAD so the following GET is a hit', async () => {
		const started = await listen()
		server = started.server

		const head = await fetch(`${started.base}/${KEY}`, { method: 'HEAD' })

		expect(head.status).toBe(200)
		expect(head.headers.get('x-cache')).toBe('MISS')
		expect(head.headers.get('content-type')).toBe('text/css')
		expect(head.headers.get('cache-control')).toBe(CACHE_CONTROL)
		expect(head.headers.get('content-length')).toBe(String(BODY.byteLength))
		expect(await head.text()).toBe('')

		const get = await fetch(`${started.base}/${KEY}`)
		expect(get.status).toBe(200)
		expect(get.headers.get('x-cache')).toBe('HIT')
		expect(started.send).toHaveBeenCalledTimes(1)
	})

	it('still answers 404 for POST and for keys outside assets/', async () => {
		const started = await listen()
		server = started.server

		const post = await fetch(`${started.base}/${KEY}`, { method: 'POST' })
		const head = await fetch(`${started.base}/uploads/7/secret.png`, {
			method: 'HEAD',
		})

		expect(post.status).toBe(404)
		expect(head.status).toBe(404)
		expect(started.send).not.toHaveBeenCalled()
	})
})
