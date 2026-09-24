import { DataSource } from 'typeorm'
import { asRows } from '../common/pg-rows'
import base from '../database/data-source'
import { JobQueueService } from '../jobs/job-queue.service'

const JOB_COUNT = 8
const WORK_MS = 200
const SEQUENTIAL_MIN_MS = JOB_COUNT * WORK_MS

async function main(): Promise<void> {
	const ds = new DataSource({
		...base.options,
	})
	await ds.initialize()
	const queue = new JobQueueService(ds)

	try {
		const inserted = asRows<{ id: string }>(
			await ds.query(
				`
				INSERT INTO jobs (kind, payload, status)
				SELECT 'demo.work', '{}'::jsonb, 'pending'
				FROM generate_series(1, $1)
				RETURNING id
				`,
				[JOB_COUNT],
			),
		)
		const jobIds = inserted.map((row) => String(row.id))

		const startedAt = Date.now()
		const [worker1, worker2] = await Promise.all([
			queue.runWorker(jobIds, 'worker-1', WORK_MS),
			queue.runWorker(jobIds, 'worker-2', WORK_MS),
		])
		const elapsedMs = Date.now() - startedAt

		const doubleRows = asRows<{ n: string }>(
			await ds.query(
				`
				SELECT count(*)::text AS n
				FROM jobs
				WHERE id = ANY($1::bigint[]) AND processed_count > 1
				`,
				[jobIds],
			),
		)
		const doubleCount = Number(doubleRows[0].n)

		const overlap = worker1.filter((id) => worker2.includes(id))
		const totalClaimed = worker1.length + worker2.length

		console.log(`worker-1: ${worker1.length}`)
		console.log(`worker-2: ${worker2.length}`)
		console.log(`оброблено двічі: ${doubleCount}`)
		console.log(`час: ${elapsedMs}`)
		console.log(`послідовний мінімум: ${SEQUENTIAL_MIN_MS}`)

		if (
			doubleCount !== 0 ||
			overlap.length !== 0 ||
			worker1.length === 0 ||
			worker2.length === 0 ||
			totalClaimed !== JOB_COUNT ||
			elapsedMs >= SEQUENTIAL_MIN_MS
		) {
			process.exitCode = 1
		}
	} finally {
		await ds.destroy()
	}
}

main().catch((err: unknown) => {
	console.error(err)
	process.exitCode = 1
})
