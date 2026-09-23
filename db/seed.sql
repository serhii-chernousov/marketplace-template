-- Re-runnable on an already-applied schema.
TRUNCATE order_items, orders, products, categories, users RESTART IDENTITY CASCADE;

-- ~200 sellers, ~799 buyers, 1 admin. IDENTITY ids: 1..200 sellers, 201..999 buyers, 1000 admin.
INSERT INTO users (email, full_name, role)
SELECT
	'user' || i || '@shop.local',
	'User ' || i,
	CASE
		WHEN i <= 200 THEN 'seller'
		WHEN i = 1000 THEN 'admin'
		ELSE 'buyer'
	END
FROM generate_series(1, 1000) AS s(i);

INSERT INTO categories (slug, title)
SELECT
	'cat-' || i,
	'Category ' || i
FROM generate_series(1, 20) AS s(i);

-- 100k rows so q3 (lower(name)) is not a Seq Scan on a tiny table.
-- Name frequencies via random(): long tail of unique titles, a few shared
-- names at different rarities. 'vintage lamp' is ~0.045% so the expression
-- index is selective; i % N would paint it evenly across the heap.
INSERT INTO products (seller_id, category_id, name, description, price_cents, stock, is_active)
SELECT
	((i - 1) % 200) + 1,
	((i - 1) % 20) + 1,
	CASE
		WHEN r < 0.00015 THEN 'Vintage Lamp'
		WHEN r < 0.00030 THEN 'VINTAGE LAMP'
		WHEN r < 0.00045 THEN 'vintage lamp'
		WHEN r < 0.003 THEN 'Ceramic Mug'
		WHEN r < 0.02 THEN 'Wooden Chair'
		ELSE 'Product ' || i
	END,
	'Description for product ' || i,
	(1000 + trunc(r_price * 99000))::integer,
	(r_stock * 100)::integer,
	(r_active > 0.10)
FROM (
	SELECT i, random() AS r, random() AS r_price, random() AS r_stock, random() AS r_active
	FROM generate_series(1, 100000) AS s(i)
) AS src;

-- Skewed statuses, dates spread over a year.
-- random() must sit in the same FROM as generate_series; LATERAL without
-- a correlation is folded to a single value and every row gets one status.
INSERT INTO orders (user_id, status, total_cents, created_at)
SELECT
	((i - 1) % 799) + 201,
	CASE
		WHEN r < 0.05 THEN 'cancelled'
		WHEN r < 0.25 THEN 'pending'
		WHEN r < 0.33 THEN 'shipped'
		WHEN r < 0.40 THEN 'delivered'
		ELSE 'paid'
	END,
	0,
	timestamptz '2025-01-01' + (r_date * interval '365 days')
FROM (
	SELECT i, random() AS r, random() AS r_date
	FROM generate_series(1, 100000) AS s(i)
) AS src;

-- One item per order; every third order gets a second item with a different product_id.
INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
SELECT
	o.id,
	p.id,
	(n % 3) + 1,
	p.price_cents
FROM orders AS o
CROSS JOIN generate_series(1, 2) AS n
JOIN products AS p ON p.id = ((o.id + n - 2) % 100000) + 1
WHERE n = 1 OR o.id % 3 = 0;

UPDATE orders AS o
SET total_cents = s.total
FROM (
	SELECT order_id, sum(quantity * unit_price_cents) AS total
	FROM order_items
	GROUP BY order_id
) AS s
WHERE o.id = s.order_id;

-- VACUUM cannot run inside a transaction. ANALYZE alone does not set the visibility map.
VACUUM (ANALYZE);
