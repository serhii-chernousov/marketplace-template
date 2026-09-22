import { MigrationInterface, QueryRunner } from 'typeorm'

export class InitSchema1790007847172 implements MigrationInterface {
	name = 'InitSchema1790007847172'

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "categories" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "slug" text NOT NULL, "title" text NOT NULL, CONSTRAINT "categories_slug_uniq" UNIQUE ("slug"), CONSTRAINT "PK_24dbc6126a28ff948da33e97d3b" PRIMARY KEY ("id"))`,
		)
		await queryRunner.query(
			`CREATE TABLE "products" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "name" text NOT NULL, "description" text NOT NULL DEFAULT '', "price_cents" integer NOT NULL, "stock" integer NOT NULL DEFAULT '0', "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "seller_id" bigint NOT NULL, "category_id" bigint, CONSTRAINT "products_stock_chk" CHECK (stock >= 0), CONSTRAINT "products_price_chk" CHECK (price_cents > 0), CONSTRAINT "products_name_chk" CHECK (length(btrim(name)) > 0), CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`,
		)
		await queryRunner.query(
			`CREATE INDEX "idx_products_lower_name" ON "products" (lower(name))`,
		)
		await queryRunner.query(
			`CREATE TABLE "order_items" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "quantity" integer NOT NULL, "unit_price_cents" integer NOT NULL, "order_id" bigint NOT NULL, "product_id" bigint NOT NULL, CONSTRAINT "order_items_uniq" UNIQUE ("order_id", "product_id"), CONSTRAINT "order_items_price_chk" CHECK (unit_price_cents > 0), CONSTRAINT "order_items_qty_chk" CHECK (quantity > 0), CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`,
		)
		await queryRunner.query(
			`CREATE TABLE "orders" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "status" text NOT NULL DEFAULT 'pending', "total_cents" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" bigint NOT NULL, CONSTRAINT "orders_total_chk" CHECK (total_cents >= 0), CONSTRAINT "orders_status_chk" CHECK (status IN ('pending','paid','shipped','delivered','cancelled')), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`,
		)
		await queryRunner.query(
			`CREATE INDEX "idx_orders_cancelled_created" ON "orders" ("created_at") WHERE status = 'cancelled'`,
		)
		await queryRunner.query(
			`CREATE INDEX "idx_orders_user_created" ON "orders" ("user_id", "created_at")`,
		)
		await queryRunner.query(
			`CREATE TABLE "users" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "email" text NOT NULL, "full_name" text NOT NULL, "role" text NOT NULL DEFAULT 'buyer', "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "users_email_uniq" UNIQUE ("email"), CONSTRAINT "users_role_chk" CHECK (role IN ('buyer', 'seller', 'admin')), CONSTRAINT "users_email_chk" CHECK (position('@' in email) > 1), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
		)
		await queryRunner.query(
			`ALTER TABLE "products" ADD CONSTRAINT "products_seller_fk" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
		)
		await queryRunner.query(
			`ALTER TABLE "products" ADD CONSTRAINT "products_category_fk" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
		)
		await queryRunner.query(
			`ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_fk" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
		)
		await queryRunner.query(
			`ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
		)
		await queryRunner.query(
			`ALTER TABLE "orders" ADD CONSTRAINT "orders_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
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
		await queryRunner.query(
			`ALTER TABLE "orders" DROP CONSTRAINT "orders_user_fk"`,
		)
		await queryRunner.query(
			`ALTER TABLE "order_items" DROP CONSTRAINT "order_items_product_fk"`,
		)
		await queryRunner.query(
			`ALTER TABLE "order_items" DROP CONSTRAINT "order_items_order_fk"`,
		)
		await queryRunner.query(
			`ALTER TABLE "products" DROP CONSTRAINT "products_category_fk"`,
		)
		await queryRunner.query(
			`ALTER TABLE "products" DROP CONSTRAINT "products_seller_fk"`,
		)
		await queryRunner.query(`DROP TABLE "users"`)
		await queryRunner.query(`DROP INDEX "public"."idx_orders_user_created"`)
		await queryRunner.query(
			`DROP INDEX "public"."idx_orders_cancelled_created"`,
		)
		await queryRunner.query(`DROP TABLE "orders"`)
		await queryRunner.query(`DROP TABLE "order_items"`)
		await queryRunner.query(`DROP INDEX "public"."idx_products_lower_name"`)
		await queryRunner.query(`DROP TABLE "products"`)
		await queryRunner.query(`DROP TABLE "categories"`)
	}
}
