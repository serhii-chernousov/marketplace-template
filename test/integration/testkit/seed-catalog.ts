import type { DataSource } from 'typeorm'
import { User } from '../../../src/entities/user.entity'

/**
 * Seeds the catalog needed by POST /v1/orders for listing-1 ("Vintage Lamp").
 * Uses ON CONFLICT DO UPDATE so stock/balance stay repeatable across verifications.
 */
export async function seedVintageLampCatalog(ds: DataSource): Promise<void> {
	await ds.query(`
		INSERT INTO users (email, full_name, role, balance_cents)
		VALUES
			('seller1@shop.local', 'Seller One', 'seller', 0),
			('buyer1@shop.local', 'Buyer One', 'buyer', 100000000)
		ON CONFLICT (email) DO UPDATE
			SET balance_cents = EXCLUDED.balance_cents,
			    role = EXCLUDED.role
	`)
	const seller = await ds.getRepository(User).findOneByOrFail({
		email: 'seller1@shop.local',
	})
	await ds.query(
		`
		INSERT INTO products (name, description, price_cents, stock, is_active, seller_id)
		VALUES ('Vintage Lamp', '', 4599, 12, true, $1)
		ON CONFLICT (name) DO UPDATE
			SET stock = EXCLUDED.stock,
			    price_cents = EXCLUDED.price_cents,
			    is_active = true
		`,
		[seller.id],
	)
}
