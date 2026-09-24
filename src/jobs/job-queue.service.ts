import { Injectable } from '@nestjs/common'
import { DataSource, EntityManager } from 'typeorm'
import { asRows } from '../common/pg-rows'

export interface ClaimedJob {
	id: string
	kind: string
	payload: Record<string, unknown>
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Job queue claimed with FOR UPDATE SKIP LOCKED.
 * Injectable in Nest; demos may `new JobQueueService(dataSource)`.
 */
@Injectable()
export class JobQueueService {
	constructor(private readonly dataSource: DataSource) {}

	/**
	 * Claim one pending job from the given id set.
	 * Must run inside an open transaction; lock is held until COMMIT/ROLLBACK.
	 */
	async claimJob(
		manager: EntityManager,
		jobIds: string[],
	): Promise<ClaimedJob | null> {
		if (jobIds.length === 0) {
			return null
		}
		const rows = asRows<{
			id: string
			kind: string
			payload: Record<string, unknown>
		}>(
			await manager.query(
				`
				SELECT id, kind, payload
				FROM jobs
				WHERE status = 'pending' AND id = ANY($1::bigint[])
				ORDER BY id
				FOR UPDATE SKIP LOCKED
				LIMIT 1
				`,
				[jobIds],
			),
		)
		if (rows.length === 0) {
			return null
		}
		return {
			id: String(rows[0].id),
			kind: rows[0].kind,
			payload: rows[0].payload,
		}
	}

	async completeJob(
		manager: EntityManager,
		jobId: string,
		workerId: string,
	): Promise<void> {
		await manager.query(
			`
			UPDATE jobs
			SET status = 'done',
				processed_count = processed_count + 1,
				worker_id = $2
			WHERE id = $1
			`,
			[jobId, workerId],
		)
	}

	/**
	 * Drain jobs whose ids are in jobIds. Empty SKIP LOCKED result means
	 * "busy now", not "queue empty" — re-check pending count before exit.
	 */
	async runWorker(
		jobIds: string[],
		workerId: string,
		workMs: number,
	): Promise<string[]> {
		const processed: string[] = []

		for (;;) {
			const claimed = await this.dataSource.transaction(
				async (manager) => {
					const job = await this.claimJob(manager, jobIds)
					if (!job) {
						return null
					}
					await delay(workMs)
					await this.completeJob(manager, job.id, workerId)
					return job.id
				},
			)

			if (claimed) {
				processed.push(claimed)
				continue
			}

			const pendingRows = asRows<{ n: string }>(
				await this.dataSource.query(
					`
					SELECT count(*)::text AS n
					FROM jobs
					WHERE status = 'pending' AND id = ANY($1::bigint[])
					`,
					[jobIds],
				),
			)
			if (Number(pendingRows[0].n) === 0) {
				return processed
			}
			await delay(20)
		}
	}
}
