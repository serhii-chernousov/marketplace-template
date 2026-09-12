CREATE INDEX idx_orders_user_created
	ON orders (user_id, created_at);

CREATE INDEX idx_orders_cancelled_created
	ON orders (created_at)
	WHERE status = 'cancelled';

CREATE INDEX idx_products_lower_name
	ON products (lower(name));
