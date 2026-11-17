import { readFileSync } from 'node:fs'

/**
 * Runs as a separate process with an empty environment and imports nothing
 * from the app: it holds no storage key, only the presigned URL it is handed.
 */
async function main(): Promise<void> {
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer)
	}
	const { url, contentType, filePath } = JSON.parse(
		Buffer.concat(chunks).toString(),
	) as { url: string; contentType: string; filePath: string }

	const credentialVars = Object.keys(process.env).filter((name) =>
		/^(STORAGE_|AWS_|MINIO_)/.test(name),
	)
	const res = await fetch(url, {
		method: 'PUT',
		headers: { 'Content-Type': contentType },
		body: readFileSync(filePath),
	})
	console.log(`credential-vars=${credentialVars.length}`)
	console.log(`status=${res.status}`)
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
})
