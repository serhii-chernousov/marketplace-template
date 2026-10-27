import { Job, Queue, Worker } from 'bullmq'
import { waitUntil } from '../common/sleep'
import { printMetrics } from './print-metrics'
import {
	QUEUE_PREFIX,
	RATING_QUEUE,
	RECALC_JOB,
	SWEEP_JOB,
	SWEEP_SCHEDULER_ID,
	ratingJobOptions,
	upsertSweepScheduler,
	type RatingJobData,
} from '../queue/rating-queue'
import { createRedis, redisConfig, requireRedisQueueUrl } from '../redis/redis'

const JOB_ID = 'recalc-rating-catalog'
const SWEEP_EVERY_MS = 300
// Own queue: the demo obliterates it, and a running worker must not steal its jobs.
const DEMO_QUEUE = `${RATING_QUEUE}-demo`

interface DemoJobData extends RatingJobData {
	failUntilAttempt?: number
}

interface RatingCounters {
	attempts: number
	scheduledRuns: number
}

/**
 * The handler throws until `failUntilAttempt` executions have happened,
 * then succeeds. A sweep job only counts a scheduler tick.
 */
async function processDemoJob(
	job: Job<DemoJobData>,
	counters: RatingCounters,
): Promise<void> {
	if (job.name === SWEEP_JOB) {
		counters.scheduledRuns += 1
		return
	}
	counters.attempts += 1
	if (counters.attempts <= (job.data.failUntilAttempt ?? 0)) {
		throw new Error('rating upstream unavailable')
	}
}

/**
 * One BullMQ queue on the noeviction Redis.
 * Two adds share a jobId, the handler fails twice then succeeds,
 * and upsertJobScheduler is called twice so a restart does not
 * duplicate the scheduler.
 */
async function main(): Promise<void> {
	const url = requireRedisQueueUrl()
	const probe = createRedis(url)
	const connection = { url, maxRetriesPerRequest: 20 }
	const workerConnection = { url, maxRetriesPerRequest: null }
	const queue = new Queue<DemoJobData>(DEMO_QUEUE, {
		connection,
		prefix: QUEUE_PREFIX,
		defaultJobOptions: ratingJobOptions,
	})
	const counters: RatingCounters = { attempts: 0, scheduledRuns: 0 }
	let completed = 0
	let added = 0
	let queued = 0
	let worker: Worker<DemoJobData> | undefined
	let exitCode = 1

	try {
		const policy = await redisConfig(probe, 'maxmemory-policy')
		await queue.waitUntilReady()
		await queue.removeJobScheduler(SWEEP_SCHEDULER_ID)
		await queue.obliterate({ force: true })

		const payload: DemoJobData = {
			productId: '1',
			failUntilAttempt: 2,
		}
		await queue.add(RECALC_JOB, payload, { jobId: JOB_ID })
		added += 1
		await queue.add(RECALC_JOB, payload, { jobId: JOB_ID })
		added += 1
		const counts = await queue.getJobCounts(
			'waiting',
			'delayed',
			'active',
			'prioritized',
		)
		queued =
			(counts.waiting ?? 0) +
			(counts.delayed ?? 0) +
			(counts.active ?? 0) +
			(counts.prioritized ?? 0)

		worker = new Worker<DemoJobData>(
			DEMO_QUEUE,
			async (job) => {
				await processDemoJob(job, counters)
			},
			{
				connection: workerConnection,
				prefix: QUEUE_PREFIX,
			},
		)
		worker.on('completed', (job) => {
			if (job.name === RECALC_JOB) {
				completed = 1
			}
		})
		worker.on('failed', () => undefined)
		worker.on('error', () => undefined)
		await worker.waitUntilReady()

		await upsertSweepScheduler(queue, SWEEP_EVERY_MS)
		await upsertSweepScheduler(queue, SWEEP_EVERY_MS)

		try {
			await waitUntil(
				() =>
					counters.attempts >= 3 &&
					completed === 1 &&
					counters.scheduledRuns >= 2,
				12_000,
			)
		} catch {
			// Metrics below show which threshold missed.
		}

		const schedulers = await queue.getJobSchedulersCount()
		const metrics = {
			'queue-noeviction': policy === 'noeviction' ? 1 : 0,
			attempts: counters.attempts,
			completed,
			added,
			queued,
			schedulers,
			'scheduled-runs': counters.scheduledRuns,
		}
		printMetrics(metrics)
		exitCode =
			metrics.completed === 1 &&
			metrics.added === 2 &&
			metrics.queued === 1 &&
			metrics['queue-noeviction'] === 1 &&
			metrics.attempts >= 3 &&
			metrics.schedulers >= 1 &&
			metrics['scheduled-runs'] >= 2
				? 0
				: 1
	} finally {
		await worker?.close()
		await queue.removeJobScheduler(SWEEP_SCHEDULER_ID)
		await queue.obliterate({ force: true })
		await queue.close()
		await probe.quit()
	}

	process.exit(exitCode)
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err)
	console.error(message)
	process.exit(1)
})
