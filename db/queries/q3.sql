SELECT id, seller_id, name, price, stock, is_active
FROM products
WHERE lower(name) = 'vintage lamp';
