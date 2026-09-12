SELECT id, user_id, status, total_amount, created_at
FROM orders
WHERE user_id = 201
	AND created_at >= TIMESTAMPTZ '2025-03-01'
	AND created_at < TIMESTAMPTZ '2025-06-01';
