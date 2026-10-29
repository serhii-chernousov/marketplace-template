import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Login credentials and rotating refresh tokens.
 *
 * Only an HMAC of the refresh token is stored, so a table dump is not a dump
 * of live sessions. All tokens of one login share family_id: a reused token
 * revokes the whole family.
 */
export class AddAuth1790500000000 implements MigrationInterface {
	name = 'AddAuth1790500000000'

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`ALTER TABLE "users" ADD COLUMN "password_hash" text`,
		)
		await queryRunner.query(`
			CREATE TABLE "refresh_tokens" (
				"id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
				"user_id" bigint NOT NULL,
				"family_id" uuid NOT NULL,
				"token_hash" text NOT NULL,
				"used_at" TIMESTAMP WITH TIME ZONE,
				"revoked_at" TIMESTAMP WITH TIME ZONE,
				"expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
				CONSTRAINT "refresh_tokens_user_fk"
					FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
			)
		`)
		await queryRunner.query(`
			CREATE UNIQUE INDEX "idx_refresh_tokens_token_hash"
			ON "refresh_tokens" ("token_hash")
		`)
		await queryRunner.query(`
			CREATE INDEX "idx_refresh_tokens_family_id"
			ON "refresh_tokens" ("family_id")
		`)
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
		await queryRunner.query(
			`DROP INDEX "public"."idx_refresh_tokens_family_id"`,
		)
		await queryRunner.query(
			`DROP INDEX "public"."idx_refresh_tokens_token_hash"`,
		)
		await queryRunner.query(`DROP TABLE "refresh_tokens"`)
		await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_hash"`)
	}
}
