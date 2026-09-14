# Оптимізація запитів (ДЗ #12)

Головна таблиця: `orders` (100 000 рядків). Індекси — у `db/indexes.sql`.
Плани знято на чистому volume: `docker compose down -v` → `up -d --wait` → `schema.sql` → `seed.sql` → EXPLAIN «до» → `indexes.sql` → `ANALYZE` → EXPLAIN «після».

Назви в seed розкидані через `random()` (не `i % N`): long tail унікальних `Product N`, рідше `Wooden Chair` / `Ceramic Mug`, `vintage lamp` ≈ 0.04%.

## q1 — замовлення власника за період

`db/queries/q1.sql`: `user_id = 201` і `created_at` у `[2025-03-01, 2025-06-01)`.

Індекс: btree `(user_id, created_at)` — спочатку рівність, потім діапазон.

Seq Scan зник; з’явився Bitmap Index Scan по `idx_orders_user_created`. Buffers: 1624 shared hit → 30 hit + 3 read.

### До

```
                                                                                QUERY PLAN
--------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Seq Scan on orders  (cost=0.00..3374.00 rows=31 width=36) (actual time=0.727..6.727 rows=28 loops=1)
   Filter: ((created_at >= '2025-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-06-01 00:00:00+00'::timestamp with time zone) AND (user_id = 201))
   Rows Removed by Filter: 99972
   Buffers: shared hit=1624
 Planning:
   Buffers: shared hit=80
 Planning Time: 0.371 ms
 Execution Time: 6.763 ms
```

### Після

```
                                                                                     QUERY PLAN
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Bitmap Heap Scan on orders  (cost=4.81..116.51 rows=31 width=36) (actual time=0.040..0.100 rows=28 loops=1)
   Recheck Cond: ((user_id = 201) AND (created_at >= '2025-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-06-01 00:00:00+00'::timestamp with time zone))
   Heap Blocks: exact=27
   Buffers: shared hit=30 read=3
   ->  Bitmap Index Scan on idx_orders_user_created  (cost=0.00..4.81 rows=31 width=0) (actual time=0.030..0.030 rows=28 loops=1)
         Index Cond: ((user_id = 201) AND (created_at >= '2025-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-06-01 00:00:00+00'::timestamp with time zone))
         Buffers: shared hit=3 read=3
 Planning:
   Buffers: shared hit=121 read=2
 Planning Time: 0.377 ms
 Execution Time: 0.140 ms
```

## q2 — фільтр за рідкісним статусом

`db/queries/q2.sql`: `status = 'cancelled'` і `created_at` у січні 2025.

Індекс: partial btree `(created_at) WHERE status = 'cancelled'`. У запиті має бути `status = 'cancelled'`, інакше partial не підхопиться.

Seq Scan зник; Bitmap Index Scan іде по вужчому індексу лише cancelled-рядків. Buffers: 1624 shared hit → 323 hit + 3 read.

### До

```
                                                                                      QUERY PLAN
---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Seq Scan on orders  (cost=0.00..3374.00 rows=414 width=36) (actual time=0.432..4.792 rows=420 loops=1)
   Filter: ((created_at >= '2025-01-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-02-01 00:00:00+00'::timestamp with time zone) AND (status = 'cancelled'::text))
   Rows Removed by Filter: 99580
   Buffers: shared hit=1624
 Planning:
   Buffers: shared hit=80
 Planning Time: 0.196 ms
 Execution Time: 4.831 ms
```

### Після

```
                                                                                         QUERY PLAN
---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Bitmap Heap Scan on orders  (cost=12.61..977.56 rows=422 width=36) (actual time=0.095..0.424 rows=420 loops=1)
   Recheck Cond: ((created_at >= '2025-01-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-02-01 00:00:00+00'::timestamp with time zone) AND (status = 'cancelled'::text))
   Heap Blocks: exact=323
   Buffers: shared hit=323 read=3
   ->  Bitmap Index Scan on idx_orders_cancelled_created  (cost=0.00..12.50 rows=422 width=0) (actual time=0.069..0.069 rows=420 loops=1)
         Index Cond: ((created_at >= '2025-01-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2025-02-01 00:00:00+00'::timestamp with time zone))
         Buffers: shared read=3
 Planning:
   Buffers: shared hit=119
 Planning Time: 0.421 ms
 Execution Time: 0.480 ms
```

## q3 — пошук без урахування регістру

`db/queries/q3.sql`: `lower(name) = 'vintage lamp'`.

Індекс: expression btree `(lower(name))`. Індекс по сирій колонці `name` цей `WHERE` ігнорує.

Seq Scan зник; став Index Scan по `idx_products_lower_name`. Збіг 44 рядки (~0.04%), тож купа майже не читається: 1538 shared hit → 43 hit + 3 read (було б ~1250 сторінок при рівномірних 3750 збігах).

### До

```
                                                QUERY PLAN
----------------------------------------------------------------------------------------------------------
 Seq Scan on products  (cost=0.00..3038.00 rows=500 width=40) (actual time=0.008..13.869 rows=44 loops=1)
   Filter: (lower(name) = 'vintage lamp'::text)
   Rows Removed by Filter: 99956
   Buffers: shared hit=1538
 Planning:
   Buffers: shared hit=75
 Planning Time: 0.208 ms
 Execution Time: 13.908 ms
```

### Після

```
                                                              QUERY PLAN
--------------------------------------------------------------------------------------------------------------------------------------
 Index Scan using idx_products_lower_name on products  (cost=0.42..80.39 rows=47 width=40) (actual time=0.030..0.156 rows=44 loops=1)
   Index Cond: (lower(name) = 'vintage lamp'::text)
   Buffers: shared hit=43 read=3
 Planning:
   Buffers: shared hit=107 read=1
 Planning Time: 0.358 ms
 Execution Time: 0.193 ms
```
