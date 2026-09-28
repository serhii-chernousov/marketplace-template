import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBalanceAndJobQueue1790200000000 implements MigrationInterface {
	name = 'AddBalanceAndJobQueue1790200000000'

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`ALTER TABLE "users" ADD "balance_cents" integer NOT NULL DEFAULT 0`,
		)
		await queryRunner.query(
			`ALTER TABLE "users" ADD CONSTRAINT "users_balance_chk" CHECK (balance_cents >= 0)`,
		)
		await queryRunner.query(`
			CREATE TABLE "jobs" (
				"id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
				"kind" text NOT NULL,
				"payload" jsonb NOT NULL,
				"status" text NOT NULL DEFAULT 'pending',
				"processed_count" integer NOT NULL DEFAULT 0,
				"worker_id" text,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "jobs_status_chk" CHECK (status IN ('pending', 'done')),
				CONSTRAINT "jobs_processed_chk" CHECK (processed_count >= 0),
				CONSTRAINT "PK_jobs" PRIMARY KEY ("id")
			)
		`)
		await queryRunner.query(
			`CREATE INDEX "idx_jobs_pending" ON "jobs" ("id") WHERE status = 'pending'`,
		)
		await queryRunner.query(`
			CREATE TABLE "concurrency_probe" (
				"id" integer NOT NULL,
				"value" integer NOT NULL,
				CONSTRAINT "PK_concurrency_probe" PRIMARY KEY ("id")
			)
		`)
		await queryRunner.query(
			`INSERT INTO "concurrency_probe" ("id", "value") VALUES (1, 0)`,
		)
		await queryRunner.query(`
DO $grant$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
		GRANT ALL ON ALL TABLES IN SCHEMA public TO app_user;
		GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO app_user;
	END IF;
END
$grant$
`)
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TABLE "concurrency_probe"`)
		await queryRunner.query(`DROP INDEX "public"."idx_jobs_pending"`)
		await queryRunner.query(`DROP TABLE "jobs"`)
		await queryRunner.query(
			`ALTER TABLE "users" DROP CONSTRAINT "users_balance_chk"`,
		)
		await queryRunner.query(
			`ALTER TABLE "users" DROP COLUMN "balance_cents"`,
		)
	}
}
