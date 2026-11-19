#!/usr/bin/env node
// Usage: node scripts/loadgen.mjs <url> <out-file>
// One line per response: the HTTP status, or 000:<error code> when no response came back.
// Runs until SIGTERM/SIGINT.
import { createWriteStream } from 'node:fs'
import http from 'node:http'

const [url, outFile] = process.argv.slice(2)
if (!url || !outFile) {
	console.error('usage: loadgen.mjs <url> <out-file>')
	process.exit(2)
}

const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 8)
// macOS keeps closed client ports in TIME_WAIT ~30s; above ~500 new connections/s
// the generator runs out of ports and reports its own EADDRNOTAVAIL as failures.
const rps = Number(process.env.LOAD_RPS ?? 250)
const timeoutMs = Number(process.env.LOAD_TIMEOUT_MS ?? 2000)
const intervalMs = (1000 * concurrency) / rps

const out = createWriteStream(outFile, { flags: 'a' })
let stopping = false
process.on('SIGTERM', () => (stopping = true))
process.on('SIGINT', () => (stopping = true))

function hit() {
	return new Promise((resolve) => {
		let settled = false
		const done = (line) => {
			if (!settled) {
				settled = true
				resolve(line)
			}
		}
		// agent:false = a fresh TCP connection per request, like curl; no keep-alive pinning to a dying pod.
		const req = http.get(url, { agent: false, timeout: timeoutMs }, (res) => {
			res.on('error', (err) => done(`000:${err.code ?? 'EBODY'}`))
			res.on('end', () => done(String(res.statusCode)))
			res.resume()
		})
		req.on('timeout', () =>
			req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
		)
		req.on('error', (err) => done(`000:${err.code ?? 'EUNKNOWN'}`))
	})
}

async function worker() {
	while (!stopping) {
		const started = Date.now()
		out.write(`${await hit()}\n`)
		const wait = intervalMs - (Date.now() - started)
		if (wait > 0) await new Promise((r) => setTimeout(r, wait))
	}
}

await Promise.all(Array.from({ length: concurrency }, worker))
await new Promise((resolve) => out.end(resolve))
