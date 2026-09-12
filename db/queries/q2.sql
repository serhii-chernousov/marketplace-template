SELECT id, user_id, status, total_amount, created_at
FROM orders
WHERE status = 'cancelled'
	AND created_at >= TIMESTAMPTZ '2025-01-01'
	AND created_at < TIMESTAMPTZ '2025-02-01';
