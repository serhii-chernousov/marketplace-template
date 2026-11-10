import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

interface UploaderInput {
	apiBase: string
	token: string
	fileId: string
	filePath: string
	crashAfter?: number
}

interface UploadParts {
	part_size: number
	missing: Array<{ part_number: number; url: string }>
}

function readPart(
	filePath: string,
	partNumber: number,
	partSize: number,
): Buffer<ArrayBuffer> {
	const fd = openSync(filePath, 'r')
	try {
		const offset = (partNumber - 1) * partSize
		const part = Buffer.alloc(Math.min(partSize, fstatSync(fd).size - offset))
		readSync(fd, part, 0, part.length, offset)
		return part
	} finally {
		closeSync(fd)
	}
}

/**
 * A resumable client: it always starts by asking the API which parts the
 * storage already has, then uploads only the rest. crashAfter simulates a
 * dropped connection by killing the process mid-upload.
 */
async function main(): Promise<void> {
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer)
	}
	const input = JSON.parse(Buffer.concat(chunks).toString()) as UploaderInput

	const res = await fetch(`${input.apiBase}/v1/uploads/${input.fileId}/parts`, {
		headers: { Authorization: `Bearer ${input.token}` },
	})
	if (res.status !== 200) {
		throw new Error(`GET parts answered ${res.status}`)
	}
	const plan = (await res.json()) as UploadParts

	let uploaded = 0
	for (const { part_number, url } of plan.missing) {
		const put = await fetch(url, {
			method: 'PUT',
			body: readPart(input.filePath, part_number, plan.part_size),
		})
		if (put.status !== 200) {
			throw new Error(`part ${part_number} answered ${put.status}`)
		}
		uploaded += 1
		if (uploaded === input.crashAfter) {
			process.kill(process.pid, 'SIGKILL')
		}
	}
	console.log(`uploaded=${uploaded}`)
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
})
