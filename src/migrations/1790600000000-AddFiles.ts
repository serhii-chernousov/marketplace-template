import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Uploaded files. The list of a user's files lives here, not in a bucket
 * listing: a row is PENDING until commit has seen the object with HeadObject.
 */
export class AddFiles1790600000000 implements MigrationInterface {
	name = 'AddFiles1790600000000'

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`
			CREATE TABLE "files" (
				"id" uuid NOT NULL DEFAULT gen_random_uuid(),
				"owner_id" bigint NOT NULL,
				"key" text NOT NULL,
				"content_type" text NOT NULL,
				"size" bigint NOT NULL,
				"status" text NOT NULL DEFAULT 'PENDING',
				"upload_id" text,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"completed_at" TIMESTAMP WITH TIME ZONE,
				CONSTRAINT "PK_files" PRIMARY KEY ("id"),
				CONSTRAINT "files_status_check" CHECK ("status" IN ('PENDING', 'COMPLETED')),
				CONSTRAINT "files_size_check" CHECK ("size" > 0),
				CONSTRAINT "files_owner_fk"
					FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE
			)
		`)
		await queryRunner.query(
			`CREATE UNIQUE INDEX "idx_files_key" ON "files" ("key")`,
		)
		await queryRunner.query(
			`CREATE INDEX "idx_files_owner_id" ON "files" ("owner_id")`,
		)
		await queryRunner.query(`
DO $grant$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
		GRANT ALL ON ALL TABLES IN SCHEMA public TO app_user;
	END IF;
END
$grant$
`)
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP INDEX "public"."idx_files_owner_id"`)
		await queryRunner.query(`DROP INDEX "public"."idx_files_key"`)
		await queryRunner.query(`DROP TABLE "files"`)
	}
}
