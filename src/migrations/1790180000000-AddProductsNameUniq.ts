import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddProductsNameUniq1790180000000 implements MigrationInterface {
	name = 'AddProductsNameUniq1790180000000'

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`ALTER TABLE "products" ADD CONSTRAINT "products_name_uniq" UNIQUE ("name")`,
		)
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`ALTER TABLE "products" DROP CONSTRAINT "products_name_uniq"`,
		)
	}
}
