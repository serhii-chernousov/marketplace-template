import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Transactional outbox, consumer inbox, and API idempotency keys.
 *
 * Column names follow the lecture (snake_case). Debezium Outbox Event Router
 * defaults to aggregatetype / aggregateid without underscores — a later CDC
 * switch sets route.by.field and table.field.event.key, consumers stay put.
 */
export class AddOutboxAndInbox1790400000000 implements MigrationInterface {
	name = 'AddOutboxAndInbox1790400000000'

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`
			CREATE TABLE "outbox" (
				"id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
				"aggregate_type" text NOT NULL,
				"aggregate_id" text NOT NULL,
				"type" text NOT NULL,
				"payload" jsonb NOT NULL,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"published_at" TIMESTAMP WITH TIME ZONE,
				"attempts" integer NOT NULL DEFAULT 0,
				CONSTRAINT "outbox_attempts_chk" CHECK (attempts >= 0),
				CONSTRAINT "PK_outbox" PRIMARY KEY ("id")
			)
		`)
		await queryRunner.query(`
			CREATE INDEX "idx_outbox_unpublished"
			ON "outbox" ("created_at", "id")
			WHERE published_at IS NULL
		`)
		await queryRunner.query(`
			CREATE TABLE "processed_messages" (
				"message_id" uuid NOT NULL,
				"consumer" text NOT NULL,
				"processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "PK_processed_messages" PRIMARY KEY ("message_id", "consumer")
			)
		`)
		await queryRunner.query(`
			CREATE TABLE "idempotency_keys" (
				"user_id" bigint NOT NULL,
				"idempotency_key" text NOT NULL,
				"order_id" bigint NOT NULL,
				"request_hash" text NOT NULL,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "PK_idempotency_keys" PRIMARY KEY ("user_id", "idempotency_key"),
				CONSTRAINT "idempotency_keys_user_fk"
					FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
				CONSTRAINT "idempotency_keys_order_fk"
					FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE
			)
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
		await queryRunner.query(`DROP TABLE "idempotency_keys"`)
		await queryRunner.query(`DROP TABLE "processed_messages"`)
		await queryRunner.query(`DROP INDEX "public"."idx_outbox_unpublished"`)
		await queryRunner.query(`DROP TABLE "outbox"`)
	}
}
