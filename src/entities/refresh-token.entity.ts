import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity('refresh_tokens')
export class RefreshToken {
	@PrimaryGeneratedColumn('identity', {
		type: 'bigint',
		generatedIdentity: 'ALWAYS',
	})
	id!: string

	@Column({ name: 'user_id', type: 'bigint' })
	userId!: string

	@Index('idx_refresh_tokens_family_id')
	@Column({ name: 'family_id', type: 'uuid' })
	familyId!: string

	@Index('idx_refresh_tokens_token_hash', { unique: true })
	@Column({ name: 'token_hash', type: 'text' })
	tokenHash!: string

	@Column({ name: 'used_at', type: 'timestamptz', nullable: true })
	usedAt!: Date | null

	@Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
	revokedAt!: Date | null

	@Column({ name: 'expires_at', type: 'timestamptz' })
	expiresAt!: Date

	@Column({
		name: 'created_at',
		type: 'timestamptz',
		default: () => 'now()',
	})
	createdAt!: Date
}
