# Оптимізація запитів (ДЗ #12)

Головна таблиця: `orders` (100 000 рядків). Індекси — у `db/indexes.sql`.
Плани знято на чистому volume: `docker compose down -v` → `up -d --wait` → `schema.sql` → `seed.sql` → EXPLAIN «до» → `indexes.sql` → `ANALYZE` → EXPLAIN «після».

## q1 — замовлення власника за період

`db/queries/q1.sql`: `user_id = 201` і `created_at` у `[2025-03-01, 2025-06-01)`.

Індекс: btree `(user_id, created_at)` — спочатку рівність, потім діапазон.

Seq Scan зник; з’явився Bitmap Index Scan по `idx_orders_user_created`. Buffers: 1624 shared hit → 26 hit + 3 read, бо читаємо ~23 сторінки купи замість усієї таблиці.

### До

```
                                                                                QUERY PLAN
--------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Seq Scan on orders  (cost=0.00..3374.00 rows=31 width=36) (actual time=0.480..4.963 rows=23 loops=1)
   Filter: ((created_at >= '2025-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-06-01 00:00:00+00'::timestamp with time zone) AND (user_id = 201))
   Rows Removed by Filter: 99977
   Buffers: shared hit=1624
 Planning:
   Buffers: shared hit=80
 Planning Time: 0.257 ms
 Execution Time: 4.986 ms
```

### Після

```
                                                                                     QUERY PLAN
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Bitmap Heap Scan on orders  (cost=4.81..116.51 rows=31 width=36) (actual time=0.041..0.098 rows=23 loops=1)
   Recheck Cond: ((user_id = 201) AND (created_at >= '2025-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-06-01 00:00:00+00'::timestamp with time zone))
   Heap Blocks: exact=23
   Buffers: shared hit=26 read=3
   ->  Bitmap Index Scan on idx_orders_user_created  (cost=0.00..4.81 rows=31 width=0) (actual time=0.033..0.033 rows=23 loops=1)
         Index Cond: ((user_id = 201) AND (created_at >= '2025-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-06-01 00:00:00+00'::timestamp with time zone))
         Buffers: shared hit=3 read=3
 Planning:
   Buffers: shared hit=121 read=2
 Planning Time: 0.469 ms
 Execution Time: 0.151 ms
```

## q2 — фільтр за рідкісним статусом

`db/queries/q2.sql`: `status = 'cancelled'` і `created_at` у січні 2025.

Індекс: partial btree `(created_at) WHERE status = 'cancelled'`. У запиті має бути `status = 'cancelled'`, інакше partial не підхопиться.

Seq Scan зник; Bitmap Index Scan іде по вужчому індексу лише cancelled-рядків. Buffers: 1624 shared hit → 344 hit + 3 read.

### До

```
                                                                                      QUERY PLAN
---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Seq Scan on orders  (cost=0.00..3374.00 rows=423 width=36) (actual time=0.394..4.734 rows=422 loops=1)
   Filter: ((created_at >= '2025-01-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-02-01 00:00:00+00'::timestamp with time zone) AND (status = 'cancelled'::text))
   Rows Removed by Filter: 99578
   Buffers: shared hit=1624
 Planning:
   Buffers: shared hit=80
 Planning Time: 0.242 ms
 Execution Time: 4.776 ms
```

### Після

```
                                                                                         QUERY PLAN
---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Bitmap Heap Scan on orders  (cost=12.62..979.42 rows=423 width=36) (actual time=0.087..0.481 rows=422 loops=1)
   Recheck Cond: ((created_at >= '2025-01-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-02-01 00:00:00+00'::timestamp with time zone) AND (status = 'cancelled'::text))
   Heap Blocks: exact=344
   Buffers: shared hit=344 read=3
   ->  Bitmap Index Scan on idx_orders_cancelled_created  (cost=0.00..12.51 rows=423 width=0) (actual time=0.060..0.060 rows=422 loops=1)
         Index Cond: ((created_at >= '2025-01-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-02-01 00:00:00+00'::timestamp with time zone))
         Buffers: shared read=3
 Planning:
   Buffers: shared hit=119
 Planning Time: 0.335 ms
 Execution Time: 0.527 ms
```

## q3 — пошук без урахування регістру

`db/queries/q3.sql`: `lower(name) = 'vintage lamp'`.

Індекс: expression btree `(lower(name))`. Індекс по сирій колонці `name` цей `WHERE` ігнорує.

Seq Scan зник; Bitmap Index Scan по `idx_products_lower_name`. Buffers: 1537 shared hit → 1341 hit + 6 read — купа все ще читається, бо збіг 3750 рядків; повний прохід 100 000 рядків більше не потрібен.

### До

```
                                                 QUERY PLAN
------------------------------------------------------------------------------------------------------------
 Seq Scan on products  (cost=0.00..3037.00 rows=500 width=40) (actual time=0.018..14.811 rows=3750 loops=1)
   Filter: (lower(name) = 'vintage lamp'::text)
   Rows Removed by Filter: 96250
   Buffers: shared hit=1537
 Planning:
   Buffers: shared hit=75
 Planning Time: 0.233 ms
 Execution Time: 14.943 ms
```

### Після

```
                                                              QUERY PLAN
---------------------------------------------------------------------------------------------------------------------------------------
 Bitmap Heap Scan on products  (cost=89.64..1683.18 rows=3770 width=40) (actual time=0.269..1.694 rows=3750 loops=1)
   Recheck Cond: (lower(name) = 'vintage lamp'::text)
   Heap Blocks: exact=1341
   Buffers: shared hit=1341 read=6
   ->  Bitmap Index Scan on idx_products_lower_name  (cost=0.00..88.69 rows=3770 width=0) (actual time=0.173..0.174 rows=3750 loops=1)
         Index Cond: (lower(name) = 'vintage lamp'::text)
         Buffers: shared read=6
 Planning:
   Buffers: shared hit=107 read=1
 Planning Time: 0.332 ms
 Execution Time: 1.840 ms
```
