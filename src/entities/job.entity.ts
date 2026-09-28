import {
	Check,
	Column,
	Entity,
	PrimaryGeneratedColumn,
} from 'typeorm'

export type JobStatus = 'pending' | 'done'

/**
 * Post-processing queue row (email/receipt). Claimed with FOR UPDATE SKIP LOCKED.
 */
@Entity('jobs')
@Check('jobs_status_chk', `status IN ('pending', 'done')`)
@Check('jobs_processed_chk', 'processed_count >= 0')
export class Job {
	@PrimaryGeneratedColumn('identity', {
		type: 'bigint',
		generatedIdentity: 'ALWAYS',
	})
	id!: string

	@Column({ type: 'text' })
	kind!: string

	@Column({ type: 'jsonb' })
	payload!: Record<string, unknown>

	@Column({ type: 'text', default: 'pending' })
	status!: JobStatus

	@Column({ name: 'processed_count', type: 'int', default: 0 })
	processedCount!: number

	@Column({ name: 'worker_id', type: 'text', nullable: true })
	workerId!: string | null

	@Column({
		name: 'created_at',
		type: 'timestamptz',
		default: () => 'now()',
	})
	createdAt!: Date
}
