import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

export type StoredFileStatus = 'PENDING' | 'COMPLETED'

@Index('idx_files_owner_idempotency', ['ownerId', 'idempotencyKey'], {
	unique: true,
})
@Entity('files')
export class StoredFile {
	@PrimaryGeneratedColumn('uuid')
	id!: string

	@Index('idx_files_owner_id')
	@Column({ name: 'owner_id', type: 'bigint' })
	ownerId!: string

	@Index('idx_files_key', { unique: true })
	@Column({ type: 'text' })
	key!: string

	@Column({ name: 'content_type', type: 'text' })
	contentType!: string

	/** Size the client announced at intent; commit compares it with HeadObject. */
	@Column({ type: 'bigint' })
	size!: string

	@Column({ type: 'text', default: 'PENDING' })
	status!: StoredFileStatus

	@Column({ name: 'upload_id', type: 'text', nullable: true })
	uploadId!: string | null

	/** With owner_id, the client's Idempotency-Key. Null only on rows from before the column existed. */
	@Column({ name: 'idempotency_key', type: 'text', nullable: true })
	idempotencyKey!: string | null

	/** Hash of the intent body, so the same key with a different body is a conflict. */
	@Column({ name: 'request_hash', type: 'text', nullable: true })
	requestHash!: string | null

	@Column({
		name: 'created_at',
		type: 'timestamptz',
		default: () => 'now()',
	})
	createdAt!: Date

	@Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
	completedAt!: Date | null
}
