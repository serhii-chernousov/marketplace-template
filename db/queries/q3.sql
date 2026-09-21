SELECT id, seller_id, name, price_cents, stock, is_active
FROM products
WHERE lower(name) = 'vintage lamp';
