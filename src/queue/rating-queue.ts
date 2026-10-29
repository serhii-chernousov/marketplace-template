import type { JobsOptions, Queue } from 'bullmq'

/** Queue name shared by the producer, the worker, and the scheduler. */
export const RATING_QUEUE = 'rating-recalc'
export const RECALC_JOB = 'recalc-rating'
export const SWEEP_JOB = 'rating-sweep'
export const SWEEP_SCHEDULER_ID = 'rating-sweep'
export const QUEUE_PREFIX = 'hw23'

/**
 * removeOnComplete: true drops the job id and the next add with the
 * same jobId is no longer a duplicate. Keep the id for an hour.
 * Jitter is a fraction in [0, 1], not milliseconds.
 */
export const ratingJobOptions: JobsOptions = {
	attempts: 3,
	backoff: { type: 'exponential', delay: 50, jitter: 0.5 },
	removeOnComplete: { age: 3600 },
	removeOnFail: { age: 3600 },
}

export interface RatingJobData {
	productId?: string
}

/**
 * upsert, not add: a restart replaces the scheduler instead of
 * registering a second one.
 */
export async function upsertSweepScheduler(
	queue: Queue,
	everyMs: number,
): Promise<void> {
	await queue.upsertJobScheduler(
		SWEEP_SCHEDULER_ID,
		{ every: everyMs },
		{
			name: SWEEP_JOB,
			data: {},
			opts: { attempts: 1, removeOnComplete: { age: 3600 } },
		},
	)
}
