import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

export type StoredFileStatus = 'PENDING' | 'COMPLETED'

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

	@Column({
		name: 'created_at',
		type: 'timestamptz',
		default: () => 'now()',
	})
	createdAt!: Date

	@Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
	completedAt!: Date | null
}
