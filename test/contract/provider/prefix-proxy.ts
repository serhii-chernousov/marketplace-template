import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Forwards Pact contract paths (/orders) to Nest routes (/v1/orders).
 * OpenAPI paths are relative to servers.url .../v1; Nest controllers include the prefix.
 */
export function listenPrefixProxy(upstreamPort: number): Promise<{
	port: number
	close: () => Promise<void>
}> {
	const server = http.createServer((req, res) => {
		const incoming = req.url ?? '/'
		const path = incoming.startsWith('/v1') ? incoming : `/v1${incoming}`
		const upstream = http.request(
			{
				hostname: '127.0.0.1',
				port: upstreamPort,
				path,
				method: req.method,
				headers: req.headers,
			},
			(up) => {
				res.writeHead(up.statusCode ?? 500, up.headers)
				up.pipe(res)
			},
		)
		upstream.on('error', () => {
			res.writeHead(502)
			res.end()
		})
		req.pipe(upstream)
	})
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address() as AddressInfo
			resolve({
				port: address.port,
				close: () =>
					new Promise((done, reject) => {
						server.close((err) => (err ? reject(err) : done()))
					}),
			})
		})
	})
}
