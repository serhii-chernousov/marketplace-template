import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrderPlacedEffects1790300000000 implements MigrationInterface {
	name = 'AddOrderPlacedEffects1790300000000'

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`
			CREATE TABLE "order_placed_effects" (
				"event_id" uuid NOT NULL,
				"order_id" text NOT NULL,
				"occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL,
				"acked_at" TIMESTAMP WITH TIME ZONE,
				CONSTRAINT "PK_order_placed_effects" PRIMARY KEY ("event_id")
			)
		`)
		await queryRunner.query(`
			CREATE TABLE "order_placed_deliveries" (
				"id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
				"event_id" uuid NOT NULL,
				"received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "PK_order_placed_deliveries" PRIMARY KEY ("id")
			)
		`)
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TABLE "order_placed_deliveries"`)
		await queryRunner.query(`DROP TABLE "order_placed_effects"`)
	}
}
