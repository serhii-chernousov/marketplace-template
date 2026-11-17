import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Expand step: old and new code both run against this schema during a
 * rolling update, so the column is nullable and nothing reads it yet.
 * The index is built CONCURRENTLY so writes to products never block.
 */
export class AddProductsSlug1790800000000 implements MigrationInterface {
	name = 'AddProductsSlug1790800000000'
	transaction = false

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "slug" text`,
		)
		await queryRunner.query(`SET lock_timeout = '5s'`)
		await queryRunner.query(`
			CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_products_slug"
				ON "products" ("slug")
		`)
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_products_slug"`,
		)
		await queryRunner.query(
			`ALTER TABLE "products" DROP COLUMN IF EXISTS "slug"`,
		)
	}
}
