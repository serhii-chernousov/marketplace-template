# Marketplace API (hw-14)

## Ресурси

- `GET/POST /v1/listings`, `GET/PATCH /v1/listings/{id}`
- `GET/POST /v1/orders`, `GET /v1/orders/{id}` — create йде в Postgres через `CheckoutService`

Гроші — цілі копійки в API (`price_cents`, `total_cents`) і в SQL (`products.price_cents`, `orders.total_cents`, `order_items.unit_price_cents`). Ідентифікація користувача — тимчасові заголовки `X-User-Id` і `X-User-Role` (`buyer` | `seller`). Для DB-checkout: `buyer-1`…`buyer-5` (або email / numeric id з сіду).

## Структура `src/`

| Каталог | Призначення |
| --- | --- |
| `checkout/` | `CheckoutService` — транзакційний checkout |
| `orders/`, `listings/`, `health/` | Nest feature-модулі (controller + service) |
| `jobs/` | черга `FOR UPDATE SKIP LOCKED` |
| `database/` | CLI DataSource, `DatabaseModule`, `DbService` |
| `store/` | in-memory catalog/idempotency для OpenAPI |
| `common/` | `with-retry`, `asRows` |
| `demo/` | CLI-скрипти гонки / воркерів / retry / N+1 |
| `entities/`, `migrations/` | схема TypeORM |

## Встановлення

```bash
npm install
```

## Запуск

```bash
npm start
```

Сервер: `http://localhost:3000`

## Configuration

Змінні описує Zod-схема `src/config/env.schema.ts`. Контракт для git — `.env.example`; реальний `.env` у `.gitignore` і не потрапляє в Docker-образ. У `.env.example` паролі фейкові.

TypeORM CLI (`src/database/data-source.ts`) читає `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` з `process.env` — їх треба тримати в Infisical `dev` (основний шлях: `infisical run`). Nest HTTP піднімає той самий TypeORM через `DatabaseModule` (`DB_PASSWORD` з Config). `/db` health додатково вміє читати `secrets/db_password` (ДЗ #11) з fallback на `DB_PASSWORD`.

| Змінна        | Обов'язкова        | Опис                                                                 |
| ------------- | ------------------ | -------------------------------------------------------------------- |
| `PORT`        | так                | HTTP-порт                                                            |
| `DB_HOST`     | так                | Хост Postgres (`localhost` для Nest на хості)                        |
| `DB_PORT`     | так                | Порт Postgres                                                        |
| `DB_USER`     | так                | Роль застосунку (`app_user`) або `admin` для CLI грейдера             |
| `DB_PASSWORD` | так                | Пароль для TypeORM DataSource (`migrate` / `seed` / `demo` / `report`) |
| `DB_NAME`     | так                | Ім'я бази (`shop`)                                                   |
| `DB_URL`      | так                | Рядок підключення Nest; джерело — сховище                            |
| `LOG_LEVEL`   | ні (дефолт `info`) | `debug` \| `info` \| `warn` \| `error`                               |
| `TIMEOUT_MS`  | ні (дефолт `5000`) | Таймаут у мс                                                         |

## Postgres (ДЗ #12)

Головна таблиця: `orders`. Гроші в таблицях — `integer` у копійках (`price_cents`, `total_cents`, `unit_price_cents`), не `numeric`/`float`.

Підняти базу:

```bash
docker compose up -d --wait
```

Підключитись:

```bash
docker compose exec db psql -U admin -d shop -Atc "SELECT 1"
```

Схема **не** монтується в `docker-entrypoint-initdb.d` — грейдер застосовує файли сам. Дев-креденшели контейнера (`admin` / `admin-secret` / `shop`) задані в `docker-compose.yaml`; пароль ролі `app_user` для Nest — у сховищі (`secrets/db_password`, приклад — `secrets/db_password.example`).

Прогін на чистому volume:

```bash
docker compose down -v
docker compose up -d --wait
docker compose exec -T db psql -U admin -d shop -v ON_ERROR_STOP=1 < db/schema.sql
docker compose exec -T db psql -U admin -d shop -v ON_ERROR_STOP=1 < db/seed.sql
docker compose exec -T db psql -U admin -d shop -Atc "SELECT count(*) FROM orders;"
docker compose exec -T db psql -U admin -d shop -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q1.sql)"
docker compose exec -T db psql -U admin -d shop -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q2.sql)"
docker compose exec -T db psql -U admin -d shop -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q3.sql)"
docker compose exec -T db psql -U admin -d shop -v ON_ERROR_STOP=1 < db/indexes.sql
docker compose exec -T db psql -U admin -d shop -c "ANALYZE;"
docker compose exec -T db psql -U admin -d shop -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q1.sql)"
docker compose exec -T db psql -U admin -d shop -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q2.sql)"
docker compose exec -T db psql -U admin -d shop -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q3.sql)"
```

До `indexes.sql` кожен EXPLAIN має містити `Seq Scan`. Після — `Index Scan`, `Index Only Scan` або `Bitmap Index Scan`, без `Seq Scan`.

### Локальний запуск з БД

```bash
cp .env.example .env
mkdir -p secrets
printf '%s' 'app-secret-initial' > secrets/db_password
docker compose up -d db
npm start
```

Перевірка: `curl -s localhost:3000/health` і `curl -s localhost:3000/db`.

Після `docker compose down -v` Postgres знову з паролем з `db/init.sql`. Поверни той самий рядок у `secrets/db_password`, інакше `password authentication failed`.

### Ротація пароля без рестарту

Порядок у `rotate.sh` фіксований: `ALTER ROLE` → оновити файл → `pg_terminate_backend`.

```bash
curl -s localhost:3000/health
bash rotate.sh
curl -s localhost:3000/db
curl -s localhost:3000/health
```

Uptime має зрости: процес Nest не перезапускається. Нові з'єднання читають уже новий пароль з файлу.

## Перевірки (acceptance criteria)

```bash
# 1. Спека валідна
npx @redocly/cli lint openapi/openapi.yaml

# 2. Обсяг спеки + Idempotency-Key
npx @redocly/cli bundle openapi/openapi.yaml -o spec.json
node -e "const s=require('./spec.json'),M=['get','post','put','patch','delete'];\
const ops=Object.entries(s.paths).flatMap(([p,v])=>Object.keys(v).filter(m=>M.includes(m)).map(m=>[p,m]));\
const idem=ops.flatMap(([p,m])=>s.paths[p][m].parameters??[]).find(x=>x.in==='header'&&/idempotency-key/i.test(x.name));\
console.log('операцій:',ops.length,'· ресурсів:',new Set(Object.keys(s.paths).map(p=>p.split('/')[1])).size);\
console.log('Idempotency-Key: required =',idem?.required,'· опис, символів =',(idem?.description??'').trim().length)"

# 3–5. Швидкі grep-перевірки
grep -c 'Idempotency-Key' openapi/openapi.yaml
grep -c 'next_cursor' openapi/openapi.yaml
grep -c 'application/problem+json' openapi/openapi.yaml
```

### Варіант Б (після `npm start`)

```bash
# без Idempotency-Key → 400 problem+json
curl -s -i -X POST http://localhost:3000/v1/orders \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: buyer-1' \
  -H 'X-User-Role: buyer' \
  -d '{"items":[{"listing_id":"listing-1","quantity":1}]}'

# порожній items → 400
curl -s -i -X POST http://localhost:3000/v1/orders \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: buyer-1' \
  -H 'X-User-Role: buyer' \
  -H 'Idempotency-Key: key-1' \
  -d '{"items":[]}'

# валідний запит → 201
curl -s -i -X POST http://localhost:3000/v1/orders \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: buyer-1' \
  -H 'X-User-Role: buyer' \
  -H 'Idempotency-Key: key-2' \
  -d '{"items":[{"listing_id":"listing-1","quantity":1}]}'
```

Повтор того самого `Idempotency-Key` + тіла → знову `201` з заголовком `Idempotency-Replay: true`. Той самий ключ з іншим тілом → `422` problem+json.

## TypeORM (ДЗ #13)

DataSource CLI: `src/database/data-source.ts`. Nest runtime: `DatabaseModule` + feature-модулі (`checkout/`, `orders/`, `jobs/`, `listings/`). `synchronize: false` — схему змінюють лише міграції.

Локально (секрети вже в оточенні, як у CI):

```bash
docker compose up -d --wait
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=admin DB_PASSWORD=admin-secret DB_NAME=shop
export SKIP_VAULT=1
npm run build
npm run migrate
npm run seed
npm run demo:nplus1
npm run report
```

Основний шлях — `bash scripts/with-secrets.sh dev …` усередині npm-скриптів (`infisical run`). У Infisical env `dev` мають бути щонайменше `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`. Файл `.secrets/infisical.env` у git немає (і не повинен). `SKIP_VAULT=1` лише обходить CLI сховища, коли ці змінні вже є в env (грейдер / локальний compose).

Nest runtime досі ходить у базу через `pg.Pool` (`DbService`); TypeORM живе в CLI-скриптах. Транзакції ДЗ #14 варто писати вже поверх `QueryRunner`, не розширюючи сирий Pool.

### onDelete

- `RESTRICT` — `products.seller_id`, `orders.user_id`, `order_items.product_id`: історію замовлень і каталог не можна стерти разом із користувачем чи товаром.
- `CASCADE` — `order_items.order_id`: позиції не існують без замовлення.
- `SET NULL` — `products.category_id`: категорію можна прибрати, товар лишається.

### N+1 (order → items → product)

`npm run demo:nplus1` бере N з argv (`npm run demo:nplus1 -- 3 24`). Без аргументів — `min(3, count(*))` і повний `count(*)` замовлень, тож на базі з 24 рядками саме доводиться незалежність від N.

На сиді з 6 замовленнями (без argv):

| Стратегія | N=3 | N=6 |
| --- | --- | --- |
| наївно (запит у циклі) | 9 | 15 (≥ N) |
| relations / leftJoinAndSelect | 1 | 1 |
| relationLoadStrategy: `query` | 5 | 5 |

`before=15 after=1`. Після фіксу число не росте з N і ≤ `1 + 2 × рівнів` (два рівні: items і product → 5).

### Repository vs QueryBuilder

`find()` / Repository — коли потрібна сутність (або граф) за PK, унікальним ключем чи простим where. QueryBuilder — коли запит не мапиться на один entity: агрегати, `GROUP BY`, звіт «виторг по категоріях» (`SUM(quantity * unit_price_cents)`). `getRawMany()` повертає рядки; `SUM` приходить рядком (`bigint`). Товари з `category_id IS NULL` (після `ON DELETE SET NULL`) потрапляють у бакет `uncategorized` через `leftJoin`, не зникають з виторгу.

### Seed

Ідемпотентний: `npm run seed && npm run seed` не змінює кількість рядків.

```bash
docker compose exec -T db psql -U admin -d shop -c "SELECT 'users' AS t, count(*) FROM users UNION ALL SELECT 'categories', count(*) FROM categories UNION ALL SELECT 'products', count(*) FROM products UNION ALL SELECT 'orders', count(*) FROM orders UNION ALL SELECT 'order_items', count(*) FROM order_items;"
```

Очікувано: users 8, categories 6, products 8, orders 6, order_items 8.

Покупці в сіді отримують `balance_cents = 100000000`, продавці й адмін — `0`. Колонка в схемі має `DEFAULT 0` (міграція ДЗ #14); гроші з’являються лише через seed.

## Конкурентність (ДЗ #14)

Checkout у `src/checkout/checkout.service.ts` — одна `dataSource.transaction`: атомарний `UPDATE … WHERE stock >= $n RETURNING`, списання `balance_cents`, `INSERT` order + order_item + job. Нестача товару чи грошей → rollback усієї транзакції. HTTP `POST /v1/orders` іде через `OrdersService` → той самий `CheckoutService` (listing title ↔ product name, `buyer-1` → `buyer1@shop.local`).

**Чому atomic UPDATE, а не `SELECT` + арифметика в JS.** `UPDATE products SET stock = stock - $n WHERE … AND stock >= $n RETURNING` одночасно перевіряє залишок і тримає row-lock до кінця транзакції. 0 рядків = відмова без вікна між читанням і записом. Окремий `SELECT … FOR UPDATE` теж коректний у тій самій транзакції, але довший і легше зіпсувати, якщо забути лок перед декрементом.

**Чому retry ловить лише `40001` і `40P01`.** Це коди PostgreSQL для serialization failure і deadlock: сервер убив транзакцію через гонку, її треба почати спочатку разом із читаннями. Constraint (`23514`) чи unique (`23505`) повторювати шкідливо — той самий запис знову впаде або створить дубль. Обгортка: `src/common/with-retry.ts`.

Числа з локальних запусків (після `migrate` + `seed`, `SKIP_VAULT=1`):

| Демо | Результат |
| --- | --- |
| `demo:race` | спроб 50, успішних 10, фінальний stock 0, відʼємних рядків 0 |
| `demo:workers` | worker-1: 4, worker-2: 4, оброблено двічі 0, час 817 мс (послідовний мінімум 1600) |
| `demo:retry` | 1 повтор з кодом `40001`, фінальний `concurrency_probe.value = 2` |

Воркери (`src/jobs/job-queue.service.ts`) беруть рядок через `FOR UPDATE SKIP LOCKED` і тримають транзакцію відкритою на час «обробки»; `status = done` і `processed_count` комітяться разом. CLI-скрипти лежать у `src/demo/`.

## Grading

```bash
docker compose up -d --wait
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=admin DB_PASSWORD=admin-secret DB_NAME=shop
export SKIP_VAULT=1    # у грейдера немає доступу до сховища
npm ci && npx tsc --noEmit
npm run build
npm run migrate
npm run migrate:show
npm run migrate:revert && npm run migrate
npm run seed && npm run seed
npm run demo:nplus1
npm run report
npm run demo:race
npm run demo:workers
npm run demo:retry
```

