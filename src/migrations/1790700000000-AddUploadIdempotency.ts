import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * One Idempotency-Key per user maps to one file row, so a double tap cannot
 * open a second PENDING multipart.
 */
export class AddUploadIdempotency1790700000000 implements MigrationInterface {
	name = 'AddUploadIdempotency1790700000000'

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`
			ALTER TABLE "files"
				ADD COLUMN "idempotency_key" text,
				ADD COLUMN "request_hash" text
		`)
		await queryRunner.query(`
			CREATE UNIQUE INDEX "idx_files_owner_idempotency"
				ON "files" ("owner_id", "idempotency_key")
		`)
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP INDEX "public"."idx_files_owner_idempotency"`)
		await queryRunner.query(`
			ALTER TABLE "files"
				DROP COLUMN "request_hash",
				DROP COLUMN "idempotency_key"
		`)
	}
}
