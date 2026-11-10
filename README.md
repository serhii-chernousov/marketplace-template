# Marketplace API (hw-26)

## Ресурси

- `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/auth/me` — JWT-автентифікація (див. [Auth](#auth))
- `GET/POST /v1/listings`, `GET/PATCH /v1/listings/{id}`
- `GET /v1/products/{id}`, `POST /v1/products` — картка товару (публічна) і запис у каталог (seller/admin)
- `GET/POST /v1/orders`, `GET /v1/orders/{id}` — create йде в Postgres через `CheckoutService`, get за id читає рядок `orders`
- `PATCH /orders/{id}/status` — зміна статусу (поза OpenAPI `/v1`); після commit емітить подію в спільну шину
- `GET /orders/{id}/events` — SSE-потік `order.status` з `id:` і підтримкою `Last-Event-ID`
- WebSocket (socket.io) — `join` у кімнату `orders:<id>` після перевірки власника; подія `order.status` лише в цю кімнату
- `POST /v1/uploads/intent`, `GET /v1/uploads/{id}/parts`, `POST /v1/uploads/{id}/commit` — завантаження файлів повз API за presigned URL, multipart із довантаженням (див. [Files](#files))

Гроші — цілі копійки в API (`price_cents`, `total_cents`) і в SQL (`products.price_cents`, `orders.total_cents`, `order_items.unit_price_cents`). Ідентифікація користувача — лише `Authorization: Bearer <access-токен>`; заголовки `X-User-Id` / `X-User-Role` більше нічого не значать. Без токена відкриті тільки вхід, refresh, перегляд оголошень і карток товарів, `/health`, `/db`. У відповідях сідові акаунти мають короткі id (`buyer-1`, `seller-1`), решта — email.

## Структура `src/`

| Каталог                           | Призначення                                                   |
| --------------------------------- | ------------------------------------------------------------- |
| `auth/`                           | JWT ES256, ротація refresh з детекцією повтору, денилист, гарди `JwtAuthGuard` / `RolesGuard` |
| `checkout/`                       | `CheckoutService` — транзакційний checkout і запис у outbox  |
| `orders/`, `listings/`, `health/` | Nest feature-модулі (controller + service + gateway)          |
| `jobs/`                           | черга `FOR UPDATE SKIP LOCKED`                                |
| `database/`                       | CLI DataSource, `DatabaseModule`, `DbService`                 |
| `store/`                          | in-memory catalog/idempotency для OpenAPI                     |
| `catalog/`                        | `GET /v1/products/:id`: картка товару, cache-aside у Redis    |
| `common/`                         | `with-retry`, `asRows`, `sleep`                               |
| `demo/`                           | CLI-скрипти гонки / воркерів / retry / N+1 / RabbitMQ / Redis |
| `messaging/`                      | RabbitMQ, transactional outbox, relay, ідемпотентний ефект    |
| `queue/`                          | BullMQ: `RatingQueueService` (продюсер), `RatingWorker`       |
| `ratelimit/`                      | `@RateLimit` + глобальний guard, ковзне вікно в Redis         |
| `redis/`                          | `RedisModule`: клієнти кеша й черги, `CONFIG GET`             |
| `session/`                        | `/v1/sessions`, middleware з rolling TTL, `SessionGuard`      |
| `storage/`                        | S3-клієнт (MinIO / AWS), presigned PUT і UploadPart          |
| `uploads/`                        | intent / parts / commit: allowlist, поріг multipart, HeadObject |
| `cdn/`                            | edge з `X-Cache` перед приватним бакетом, ассети з хешем в імені |
| `entities/`, `migrations/`        | схема TypeORM                                                 |

Realtime-файли в `orders/`: `order-events.service.ts` (шина Subject + буфер), `orders.gateway.ts` (кімнати), `order-events.controller.ts` (SSE + PATCH status). Headless-демо: `scripts/realtime-demo.mjs`.

## Встановлення

```bash
npm install
```

## Запуск

```bash
npm start
```

Сервер: `http://localhost:3000`

Воркер черги — окремий процес без HTTP (`src/worker.ts`, `WorkerModule`):

```bash
npm run start:worker
```

Збірка — `nest build` → `node dist` (`npm start`). Не запускай через `tsx`: декоратор-метадані WebSocket gateway не емітяться.

## Realtime (ДЗ #18)

Передумова: Postgres піднятий, міграції й seed застосовані, `npm start` слухає `:3000`.

### SSE

```bash
# Content-Type має бути text/event-stream
curl -sN --max-time 2 -D - -o /dev/null \
  -H 'X-User-Id: buyer-1' \
  -H 'X-User-Role: buyer' \
  http://localhost:3000/orders/order-1/events | grep -i '^content-type'

# Зміна статусу (події накопичуються в памʼяті процесу — без рестарту між кроками)
curl -s -X PATCH http://localhost:3000/orders/order-1/status \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: buyer-1' \
  -H 'X-User-Role: buyer' \
  -d '{"status":"shipped"}'

# Після ≥4 змін статусу цього замовлення — пропущені події з id > 3
curl -sN --max-time 2 -H 'Last-Event-ID: 3' \
  -H 'X-User-Id: buyer-1' \
  -H 'X-User-Role: buyer' \
  http://localhost:3000/orders/order-1/events | grep '^id:' | head -1
```

### Ізоляція кімнат (WebSocket)

Скрипт сам створює два замовлення для `buyer-1`, чекає ack від `join`, потім змінює статус замовлення A.

```bash
# різні кімнати — B не чує подію A
node scripts/realtime-demo.mjs; echo "exit=$?"
# A_RECEIVED=1
# B_RECEIVED=0
# exit=0

# контроль: обидва в кімнаті A — B чує
node scripts/realtime-demo.mjs --same-room; echo "exit=$?"
# A_RECEIVED=1
# B_RECEIVED=1
# exit=0
```

При двох інстансах in-memory `Subject` і кімнати socket.io живуть лише в тому процесі, який прийняв зʼєднання: emit на іншому інстансі клієнт не побачить. Лікується Redis-адаптером socket.io і спільним pub/sub для шини.

## Trade-offs: WebSocket vs SSE

Для нотифікацій про зміну статусу замовлення я б лишив **SSE**: канал односторонній (сервер → клієнт), відновлення вже є через `Last-Event-ID`, і це звичайний HTTP без Upgrade. WebSocket виправданий, коли клієнт сам шле команди в той самий канал (у нас це `join` у кімнату) або коли потрібен двосторонній діалог.

| Критерій                 | WebSocket                                                                                          | SSE                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Напрям каналу            | Двосторонній (клієнт ↔ сервер)                                                                     | Лише сервер → клієнт                                 |
| Реконект / відновлення   | Вручну на manager (`socket.io.on('reconnect_attempt')`); пропущені події треба відновлювати самому | Браузер сам перепідключається і шле `Last-Event-ID`  |
| Вимоги до інфраструктури | HTTP Upgrade, sticky sessions або Redis-адаптер у кластері                                         | Звичайний HTTP; проксі не повинен буферизувати потік |
| Ціна на подію            | Постійне зʼєднання + бінарний framing                                                              | Довге HTTP-зʼєднання + текстові кадри                |

## Async-події через RabbitMQ

ДЗ #18 віддавав подію лише тим, хто вже підключений. Тут між продюсером і споживачем стоїть брокер: повідомлення лежить у черзі, доки зʼявиться одержувач.

**Топологія** (оголошує споживач / bootstrap, не продюсер): topic-exchange `shop.events`, quorum-черга `shop.order.placed` з `x-dead-letter-exchange`, binding на routing key `order.placed`, окремий fanout DLX + DLQ. Після успішного checkout `OrdersService` публікує `order.placed` через confirm-канал (`createConfirmChannel` + `waitForConfirms`). Confirm означає «брокер прийняв publish», а не «хтось отримав»: без binding повідомлення зникає, а confirm усе одно позитивний.

**Prefetch.** У коді `channel.prefetch(20)`. Формула: `prefetch × час обробки < consumer_timeout` (стокові 30 хв). Один ефект — `INSERT` ≈ 5–20 мс, тож `20 × 20 мс = 0.4 с` ≪ 30 хв. Prefetch=1 був би правильним для важких задач і зайвим RTT для задач по кілька мілісекунд; prefetch=500 при обробці по 10 с дає 83 хв і пробиває таймаут.

**Власні прогони:**

| Демо             | Вихід                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| `demo:publish`   | `published=5` `delivered=5` `effect=5` `acked=5` `dlq=0` `prefetch=20` |
| `demo:dlq`       | `rejected=1` `work=0` `dlq=1` `dlq-reason=rejected` `effect=0`         |
| `demo:duplicate` | `deliveries=2` `effect=1` `skipped=1`                                  |

Дубль у `demo:duplicate` зроблено через `SIGKILL` дочірнього споживача після ефекту і до `ack`: процес зникає, ОС закриває сокет, брокер бачить обрив і повертає unacked. `channel.close()` для цього не використовуємо — це коректне завершення, а не падіння сервісу.

**Чому це at-least-once, а не exactly-once.** Доставка at-least-once: пізній ack (або обрив до ack) повертає те саме повідомлення, тож споживач може отримати його двічі. Exactly-once на рівні доставки не існує ні в кого — формулювання «RabbitMQ дає exactly-once» хибне. Exactly-once **результат** дає звʼязка: at-least-once доставка + ідемпотентний ефект `INSERT INTO order_placed_effects … ON CONFLICT (event_id) DO NOTHING`. Ідемпотентність — властивість операції; `eventId` — ключ, яким повтор роблять безпечним. Дедуп у `Set` процесу не рахується: він не переживає рестарт і не існує між репліками.

Отруєне повідомлення (`poison: true`) іде в DLQ через `channel.reject(msg, false)` з причиною `rejected`. Обрив до Postgres і інші transient-коди (`08*`, `40*`, `53*`, `57*`, `55P03`, мережеві `ECONNRESET` / `ETIMEDOUT`) повертають повідомлення в чергу через `nack(requeue=true)`. Permanent (битий JSON, невалідний payload, SQLSTATE `22*` / `23*`) теж ідуть у DLQ без requeue. На RabbitMQ 4.x `nack(requeue=true)` не інкрементить delivery-count і може крутити повідомлення вічно; для DLQ через `delivery_limit` потрібен `reject(requeue=true)` на 4.3+ — отруту сюди так не відправляємо.

**Межа, яку закриває outbox.** Раніше checkout і publish були двома commit: впасти між ними — і замовлення є, а події немає. Тепер рядок `outbox` комітиться разом із замовленням, а брокер бачить подію лише з relay. Деталі й числа прогонів — у розділі нижче.

Management UI: `http://127.0.0.1:15672` (app/app). AMQP — порт **5672**, не 15672.

## Outbox та ідемпотентність

Оформлення замовлення пише бізнес-рядок і подію `order.placed` одним `COMMIT`. `CheckoutService` у тій самій транзакції, що stock, balance, order, order_item і job, вставляє рядок у `outbox`. У payload лежить контракт з `toOrderPlacedEvent` (id події, id замовлення, покупець, сума в копійках), а не ORM-сутність. Брокера ця транзакція не викликає: RabbitMQ не вміє відкочуватись разом із Postgres.

Relay (`src/messaging/outbox-relay.ts`) опитує таблицю:

```sql
SELECT id, payload
FROM outbox
WHERE published_at IS NULL
ORDER BY created_at, id
FOR UPDATE SKIP LOCKED
LIMIT N
```

Далі `publish`, і лише після confirm брокера — `UPDATE published_at`. `SKIP LOCKED` віддає іншим воркерам інші рядки, замість того щоб вишикувати їх у чергу на один лок. `ORDER BY` задає лише порядок вибірки, не порядок доставки: глобального порядку між воркерами немає. Курсор «усі id більші за останній» тут не годиться — `bigint identity` видає номер на `nextval`, а рядок стає видимим на `COMMIT`, тож пізніший commit із меншим id губиться. Тому фільтр — `published_at IS NULL`.

**Чому не можна просто поміняти місцями publish і `UPDATE published_at`.** Якщо спершу позначити рядок винесеним, а публікувати потім, падіння між цими кроками лишає `published_at` заповненим і повідомлення, якого в брокері немає. Relay цей рядок більше не візьме — подія втрачена назавжди. Зворотний порядок (спочатку publish, потім позначка) у тій самій щілині дає дубль, а не дірку. Дубль знімає ідемпотентний ефект; втрату не лікує нічого. Навіть помилка `publish` не доводить, що повідомлення не потрапило в чергу: могла загубитись лише відповідь брокера, тож «зловив помилку → відкотив позначку → усе чисто» теж не працює.

Консюмер зводить at-least-once до одного ефекту на двох рівнях, і обидва комітяться разом:

1. Ефект сам по собі ідемпотентний: `INSERT INTO order_placed_effects … ON CONFLICT (event_id) DO NOTHING`. `eventId` народжується один раз у транзакції checkout і їде в payload, тож повтор тієї самої події не застосовує ефект удруге. Це не `UPDATE qty = qty - 1`, який на другій доставці списав би залишок ще раз.
2. Inbox: `processed_messages (message_id, consumer)` пишеться в тій самій транзакції, що й ефект. Позначити обробку в Redis, а ефект записати в Postgres — це знову dual write, тільки на боці консюмера.

Третій рівень — край API. `Idempotency-Key` разом із `user_id` є ключем наміру, не хешем тіла. Хеш тіла склеїв би два легітимні однакові кошики в одне замовлення. Хеш лежить у рядку поруч лише для контракту OpenAPI: той самий ключ з іншим тілом дає 422. Два запити з одним ключем дають один order, один рядок outbox і один ефект.

`demo:crash-relay` не вбиває процес через `kill -9`. Після успішного publish і до `UPDATE published_at` relay кидає виняток, транзакція робить `ROLLBACK`, `published_at` лишається `NULL`, а повідомлення вже лежить у черзі. Наступний прохід публікує його вдруге.

Таблиця `outbox` росте. Частковий індекс `idx_outbox_unpublished` (`WHERE published_at IS NULL`) тримає relay швидким, але heap роздувається, доки вивезені рядки не прибрати. Чистка — окремим розкладом, не в гарячому шляху: `DELETE FROM outbox WHERE published_at IS NOT NULL AND published_at < now() - interval '7 days'`. Неопубліковані рядки не чіпати.

Імена колонок — snake_case з лекції (`aggregate_type`, `published_at`, …). У Debezium Outbox Event Router за замовчуванням поля без підкреслень (`aggregatetype`, `aggregateid`). При переході на CDC достатньо перевизначити `route.by.field` і `table.field.event.key` — консюмери лишаються тими самими.

**Власні прогони** (після `docker compose up -d --wait`, `npm run build`, `npm run migrate`, `SKIP_VAULT=1`):

| Демо | Вихід |
| --- | --- |
| `demo:outbox` | `requests=2` `orders=1` `outbox=1` `published=1` `deliveries=1` `effect=1` `processed=1` |
| `demo:crash-write` | `write-failed=1` `orders=0` `outbox=0` `published=0` `deliveries=0` `effect=0` |
| `demo:crash-relay` | `published=1` `deliveries=2` `applied=1` `effect=1` `processed=1` |

Exactly-once доставки не існує — це задача двох генералів. Є at-least-once доставка плюс ідемпотентний ефект, і разом вони дають exactly-once результат. `demo:crash-relay` це показує очима: та сама подія доїхала двічі (`deliveries=2`), ефект застосовано один раз (`effect=1`).

## Configuration

Змінні описує Zod-схема `src/config/env.schema.ts`. Контракт для git — `.env.example`; реальний `.env` у `.gitignore` і не потрапляє в Docker-образ. У `.env.example` паролі фейкові.

TypeORM CLI (`src/database/data-source.ts`) читає `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` з `process.env` — їх треба тримати в Infisical `dev` (основний шлях: `infisical run`). Nest HTTP піднімає той самий TypeORM через `DatabaseModule` (`DB_PASSWORD` з Config). `/db` health додатково вміє читати `secrets/db_password` (ДЗ #11) з fallback на `DB_PASSWORD`.

| Змінна        | Обов'язкова        | Опис                                                                        |
| ------------- | ------------------ | --------------------------------------------------------------------------- |
| `PORT`        | так                | HTTP-порт                                                                   |
| `DB_HOST`     | так                | Хост Postgres (`localhost` для Nest на хості)                               |
| `DB_PORT`     | так                | Порт Postgres                                                               |
| `DB_USER`     | так                | Роль застосунку (`app_user`) або `admin` для CLI грейдера                   |
| `DB_PASSWORD` | так                | Пароль для TypeORM DataSource (`migrate` / `seed` / `demo` / `report`)      |
| `DB_NAME`     | так                | Ім'я бази (`shop`)                                                          |
| `DB_URL`      | так                | Рядок підключення Nest; джерело — сховище                                   |
| `BROKER_URL`  | так                | AMQP URL RabbitMQ (`amqp://…@host:5672`); у Infisical `dev` поруч із `DB_*` |
| `REDIS_URL`   | так                | Redis-кеш (`allkeys-lru`)                                                   |
| `REDIS_QUEUE_URL` | так            | Redis без витіснення: черга, сесії, ліміт, денилист токенів                 |
| `LOG_LEVEL`   | ні (дефолт `info`) | `debug` \| `info` \| `warn` \| `error`                                      |
| `TIMEOUT_MS`  | ні (дефолт `5000`) | Таймаут у мс                                                                |

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

| Стратегія                     | N=3 | N=6      |
| ----------------------------- | --- | -------- |
| наївно (запит у циклі)        | 9   | 15 (≥ N) |
| relations / leftJoinAndSelect | 1   | 1        |
| relationLoadStrategy: `query` | 5   | 5        |

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

Checkout у `src/checkout/checkout.service.ts` — одна `dataSource.transaction`: атомарний `UPDATE … WHERE stock >= $n RETURNING`, списання `balance_cents`, `INSERT` order + order_item + job + рядок `outbox` (і ключ `Idempotency-Key`, якщо він є). Нестача товару чи грошей → rollback усієї транзакції, включно з outbox. HTTP `POST /v1/orders` іде через `OrdersService` → той самий `CheckoutService` (listing title ↔ product name, `buyer-1` → `buyer1@shop.local`).

**Чому atomic UPDATE, а не `SELECT` + арифметика в JS.** `UPDATE products SET stock = stock - $n WHERE … AND stock >= $n RETURNING` одночасно перевіряє залишок і тримає row-lock до кінця транзакції. 0 рядків = відмова без вікна між читанням і записом. Окремий `SELECT … FOR UPDATE` теж коректний у тій самій транзакції, але довший і легше зіпсувати, якщо забути лок перед декрементом.

**Чому retry ловить лише `40001` і `40P01`.** Це коди PostgreSQL для serialization failure і deadlock: сервер убив транзакцію через гонку, її треба почати спочатку разом із читаннями. Constraint (`23514`) чи unique (`23505`) повторювати шкідливо — той самий запис знову впаде або створить дубль. Обгортка: `src/common/with-retry.ts`.

Числа з локальних запусків (після `migrate` + `seed`, `SKIP_VAULT=1`):

| Демо           | Результат                                                                          |
| -------------- | ---------------------------------------------------------------------------------- |
| `demo:race`    | спроб 50, успішних 10, фінальний stock 0, відʼємних рядків 0                       |
| `demo:workers` | worker-1: 4, worker-2: 4, оброблено двічі 0, час 817 мс (послідовний мінімум 1600) |
| `demo:retry`   | 1 повтор з кодом `40001`, фінальний `concurrency_probe.value = 2`                  |

Воркери (`src/jobs/job-queue.service.ts`) беруть рядок через `FOR UPDATE SKIP LOCKED` і тримають транзакцію відкритою на час «обробки»; `status = done` і `processed_count` комітяться разом. CLI-скрипти лежать у `src/demo/`.

## Data layer ops

Підняти стек (Postgres + PgBouncer):

```bash
docker compose up -d --wait
```

Застосунок і CLI ходять у базу через PgBouncer на порту `6432` (`DB_HOST`/`DB_PORT` або `DB_URL` у сховищі). Прямий Postgres лишається на `5432` для `docker compose exec db` (адмінські `psql` / дебаг).

Бекап і restore-drill читають `DATABASE_URL` (або fallback `DB_URL`) з оточення. Основний шлях — обгортка `scripts/with-secrets.sh`; при `SKIP_VAULT=1` вона просто виконує команду з уже заданим env.

```bash
export DATABASE_URL=postgres://admin:admin-secret@127.0.0.1:6432/shop
export SKIP_VAULT=1
bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

Дампам місце в `backups/` (локальна тека поза контейнером). Розклад — `backup.cron` (щоночі о 03:00). Протокол останнього drill — `RESTORE-DRILL.md`.

**Чому `pool_mode = transaction`.** PgBouncer віддає серверне зʼєднання клієнту лише на час транзакції, тож `default_pool_size = 8` обслуговує багато клієнтів (`max_client_conn = 200`) без роздування `max_connections` у Postgres. Це ламає сесійний стан: (1) `SET` / `RESET` — наступний запит може піти на інший backend; (2) `LISTEN` — підписка привʼязана до конкретного backend, який пулер забирає після транзакції; (3) сесійний `pg_advisory_lock` — лок лишається на backend, а не на твоєму клієнті (заміна — `pg_advisory_xact_lock`). Protocol-level prepared statements від `pg`/TypeORM тримає `max_prepared_statements = 200` у PgBouncer ≥ 1.21.

## Redis: кеш, сесії, ліміти, черга

Два контейнери, не два `SELECT`. `maxmemory` і `maxmemory-policy` спільні на весь процес Redis, тож кеш (`allkeys-lru`, `maxmemory 64mb`) і черга (`noeviction`, AOF `everysec`) не можуть жити в одному інстансі. BullMQ прямо попереджає, якщо політика не `noeviction`: витіснений ключ черги — це втрачена задача, а не «повільна деградація». Порти `16379` (кеш) і `16380` (черга) навмисно поза діапазоном лекції `22300–22399` і поза дефолтним `6379`, щоб локальний Redis і стек лекції не зайняли той самий bind.

Сесії і лічильник ліміту лежать у **черговому** Redis, не в кеші. `allkeys-lru` має право викинути будь-який ключ; для картки товару це промах і ще один `SELECT`, для сесії — розлогін, який не відтворюється. Третій інстанс не піднімав: `noeviction` вже захищає і чергу, і сесію, і ліміт.

Cache-aside стоїть на читанні картки товару `GET /v1/products/:id` (`CatalogModule`: `ProductsController` → `ProductCardService` → `ProductCardRepository`): один запит збирає рядок `products` і агрегат по `order_items` (середня кількість у рядку замовлення як рейтинг попиту — окремої таблиці відгуків у схемі немає). Промах іде в Postgres і пише ключ з TTL `300 + random(0..60)` секунд. Влучання Redis більше базу не чіпає. Запис у кеш обгорнутий: помилка `SET` не валить саме читання.

Лавина закрита single-flight локом `SET lock:… <token> NX PX`. Хто не взяв лок, чекає і перечитує кеш. Знімає лок тільки власник токена, Lua `GET` + `DEL`, не голий `DEL`.

Сесія — `SessionModule`. `POST /v1/sessions` (потрібен access-токен, сесія відкривається на його власника) видає `session_id`. `SessionMiddleware` стоїть на всіх маршрутах: якщо прийшов `X-Session-Id`, він читає сесію через `GETEX … EX`, тож будь-який запит повертає повний TTL (30 хв). `SessionGuard` закриває маршрути, яким сесія обовʼязкова (`GET`/`DELETE /v1/sessions/me`), і віддає `401`, якщо її немає або вона протухла. Після рестарту процесу ключ лишається в Redis.

Ліміт — ковзне вікно одним Lua-скриптом (`ZREMRANGEBYSCORE` + `ZCARD` + `ZADD`). Фіксоване вікно на межі хвилини пропускає до двох лімітів за кількасот мілісекунд; ковзне — ні. Два окремі клієнти ділять один ключ, тож ліміт не множиться на кількість подів. Перевищення — `429` і заголовок `Retry-After`. Ліміт вішається декоратором `@RateLimit({ limit, windowMs })`, а перевіряє його глобальний `RateLimitGuard`: `POST /v1/orders` — 10/хв, `POST /v1/sessions` — 5/хв, `GET /v1/products/:id` — 120/хв. Бакет — маршрут плюс користувач з access-токена, користувач сесії або IP. Якщо Redis недоступний, guard пропускає запит і пише warning: падіння лімітера не має класти API.

Черга `rating-recalc` рахує рейтинг поза HTTP. `attempts: 3`, `backoff: { type: 'exponential', delay: 50, jitter: 0.5 }`. Дедуп — стабільний `jobId`; `removeOnComplete: { age: 3600 }`, не `true`, інакше наступний `add` з тим самим id уже не вважається дублем. Планувальник — `upsertJobScheduler` (у BullMQ 6 `repeat` прибрано): повторний upsert з тим самим id оновлює розклад, а не плодить другий. Після замовлення `OrdersService` ставить задачу на кожен товар (`jobId` = замовлення + товар) і не чекає на неї. `RatingWorker` (окремий процес `npm run start:worker`) перебудовує картку товару в кеші. Раз на 10 хв планувальник прогріває 20 товарів, які замовляють найчастіше. Продюсер відкриває чергу при першому `add` і має обмежений reconnect: якщо Redis лежить, `add` падає за ~0.6 с, а не висить вічно. `demo:queue` ганяє власну чергу `rating-recalc-demo`, щоб запущений воркер не забрав її задачі.

**Що станеться, якщо stampede-лок зламається.** Два запити паралельно прочитають картку з Postgres. Залишок, гроші й замовлення від цього не змінюються: лок не тримає бізнес-інваріант, він лише зрізає зайві читання. Зламаний лок тут коштує ще один похід у базу. Якби від того самого `SET NX` залежало «списати stock рівно один раз», це вже був би зіпсований стан — і там потрібні транзакція, унікальний індекс або fencing token, який перевіряє саме сховище, а не Redis-лок.

Прогін після `docker compose up -d --wait`, `npm run build`, `npm run migrate`, `SKIP_VAULT=1` і URL з блоку Grading нижче:

| Демо             | Вивід                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `demo:cache`     | `cache-lru=1` `cache-maxmemory=1` `warmed=60` `ttl-distinct=36` `concurrent=20` `db-calls=1` `db-calls-warm=0` |
| `demo:session`   | `requests=3` `sessions=1` `in-redis=1` `ttl-renewed=1`                                                         |
| `demo:ratelimit` | `instances=2` `limit=5` `requests=8` `allowed=5` `blocked=3` `status=429` `retry-after=1`                      |
| `demo:queue`     | `queue-noeviction=1` `attempts=3` `completed=1` `added=2` `queued=1` `schedulers=1` `scheduled-runs=2`         |

`ttl-distinct` плаває між прогонами (джитер 0…60 с на 60 ключах). Поріг грейдера — не менше 5; без джитера було б рівно 1.

## Auth

**Домен.** «Ресурс із власником» — замовлення (`orders.user_id`): `GET /v1/orders/{id}` бачить покупець цього замовлення, продавець його товару й admin. «Ресурс, у який пише лише привілейована роль» — каталог товарів: `POST /v1/products` дозволений `seller` і `admin`, покупець отримує `403`.

### Змінні

| Змінна                 | Джерело                                    | Навіщо                                                                        |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `JWT_PRIVATE_KEY`      | сховище (#11), Infisical `dev` / `prod`    | підпис access-токенів: base64 від PKCS#8 PEM, EC P-256                        |
| `JWT_PUBLIC_KEY`       | сховище (#11), Infisical `dev` / `prod`    | перевірка підпису: base64 від SPKI PEM тієї ж пари                            |
| `JWT_KID`              | сховище (#11), Infisical `dev` / `prod`    | `kid` у заголовку токена; міняється з кожною ротацією ключа                   |
| `JWT_EXTRA_PUBLIC_KEYS` | сховище (#11), лише на час ротації         | інші ключі перевірки: `kid:<base64 SPKI PEM>` через кому; поза ротацією порожня |
| `REFRESH_TOKEN_PEPPER` | сховище (#11), Infisical `dev` / `prod`    | ключ HMAC для `refresh_tokens.token_hash`, ≥ 32 символи                       |
| `DB_HOST` … `DB_NAME`  | compose / оточення                         | дев-креденшели Postgres                                                       |
| `REDIS_QUEUE_URL`      | compose / оточення                         | noeviction-Redis: денилист, сесії, ліміт                                      |

Жодна з чотирьох змінних сховища не має дефолту в Zod-схемі: дефолт для ключа — це ключ, закомічений у git. Ціна витоку тут інша, ніж у `DB_URL`: рядок підключення дає доступ до бази з мережі, а ключ підпису дає змогу виписати собі токен будь-кого, не маючи жодного доступу. Конфіг валідується в `ConfigModule.forRoot` — до `DataSource.initialize()`, тому голий `npm run start` без ключів падає з `exit 1` і називає змінні (`JWT_PRIVATE_KEY: Invalid input…`), а не `ECONNREFUSED`. Схема також перевіряє, що ключі розбираються, що це P-256 і що публічний ключ — пара приватному. `npm run start:vault` і всі `demo:*` йдуть через `bash scripts/with-secrets.sh dev …`. Воркер черги (`start:worker`) валідує лише базову схему: ключа підпису він не тримає.

Пара для оточення генерується локально і йде одразу в сховище, повз файли репозиторію:

```bash
node scripts/jwt-keygen.mjs dev-2026-10    # три рядки KEY=value → Infisical env dev
node scripts/jwt-keygen.mjs prod-2026-10   # → Infisical env prod
bash scripts/with-secrets.sh dev node scripts/jwt-keygen.mjs --fingerprint
bash scripts/with-secrets.sh prod node scripts/jwt-keygen.mjs --fingerprint
```

Відбиток — SHA-256 від SPKI DER публічного ключа; той самий рядок застосунок пише в лог при старті для кожного ключа перевірки (`ES256 verification kid=… fingerprint=…`). Ні токени, ні їхні хвости в лог не йдуть — лише `kid`, відбиток, `family_id`, `user_id`.

| Оточення | `kid`          | Відбиток публічного ключа |
| -------- | -------------- | ------------------------- |
| dev      | `dev-2026-10`  | `SHA256:…` _(вписати вивід `--fingerprint` для dev)_  |
| prod     | `prod-2026-10` | `SHA256:…` _(вписати вивід `--fingerprint` для prod)_ |

### Токени

- **access** — JWT ES256, 10 хв. Claims: `sub` (id користувача), `role`, `sid` (= `family_id`), `jti`, `iss`, `aud`, `exp`; у заголовку `kid`.
- **refresh** — 32 випадкові байти (base64url), не JWT, 14 днів. У БД лежить не сам токен, а `HMAC-SHA256(REFRESH_TOKEN_PEPPER, token)`: дамп таблиці `refresh_tokens` — не дамп чинних сесій, навіть разом з усією базою, поки «перець» лежить у сховищі.

**Чому ES256.** OWASP JWT Cheat Sheet позначає RS256 (RSASSA-PKCS1-v1_5) як «Not recommended» і радить ES256 / PS256 / EdDSA. ES256: короткий ключ P-256 і підпис 64 байти, швидкий підпис; EdDSA `jsonwebtoken` (під `@nestjs/jwt`) не вміє. `@nestjs/jwt` зафіксовано на 11.x: 12.x — ESM-only, а jest-сьюти проєкту працюють у CJS.

**Allowlist алгоритмів.** `verifyOptions: { algorithms: ['ES256'], issuer, audience }` у `src/auth/auth.module.ts` — єдиний надійний запобіжник від algorithm confusion (RFC 8725 §3.1): токен з `alg: HS256` чи `none` відкидається до будь-якої криптографії, а `jsonwebtoken` додатково перевіряє, що ключ саме EC P-256. Токен з чужим `kid` — теж `401`. Доказ, що підпис справді перевіряється, а не декодується, — `tampered=401` у `demo:rbac`.

**Overlap-ротація ключа і роль `kid`.** `kid` каже верифікатору, яким ключем перевіряти, без перебору всіх. Верифікатор тримає звʼязку `kid → публічний ключ` (`src/auth/jwt-options.ts`): ключ `JWT_KID` плюс ключі з `JWT_EXTRA_PUBLIC_KEYS`. Підписує завжди лише `JWT_KID`; токен з `kid`, якого немає у звʼязці, отримує `401`. Ротація з ключа `A` на `B` без даунтайму — три деплої:

1. `JWT_EXTRA_PUBLIC_KEYS=B:<публічний B>`. Підпис ще ключем `A`, але кожен інстанс уже приймає `B`. Цей крок мусить завершитись на всіх інстансах до наступного, інакше токен від нового інстансу відкине старий.
2. `JWT_KID`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` → пара `B`, `JWT_EXTRA_PUBLIC_KEYS=A:<публічний A>`. Нові токени підписані `B`, видані раніше (`A`) живуть до свого `exp`.
3. Щонайменше через TTL access-токена (10 хв) токенів з `kid=A` не лишилось — `JWT_EXTRA_PUBLIC_KEYS` спорожнюється.

Схема відкидає звʼязку з битим ключем, з повтором `kid` або з `kid`, що збігається з `JWT_KID`. Refresh-токени ротація ключа підпису не зачіпає — вони непрозорі. Ротація «перцю» робить усі refresh-хеші непридатними, тобто розлогінює всіх.

### Ротація refresh і детекція повтору

Кожен успішний `POST /v1/auth/refresh` гасить предʼявлений токен (`used_at`) і видає нову пару тієї ж сімʼї (`family_id`, один логін — одна сімʼя). Усе це одна транзакція з `SELECT … FOR UPDATE` по `token_hash` (`RefreshTokenService.rotate`), тож два паралельні рефреші того самого токена серіалізуються.

Прийшов токен, у якого вже стоїть `used_at`, — це сигнал компрометації: або злодій, або чесний клієнт предʼявляє вже витрачений токен, і сервер не знає, хто з них хто. Тому відкликається **вся сімʼя** (`revoked_at`), пишеться рядок `refresh token reuse detected: family_id=… user_id=…, family revoked`, а в денилист іде `deny:sid:<family_id>`, щоб і вже видані access-токени цієї сімʼї померли одразу, а не через 10 хв. Запис у Redis не «глушиться»: якщо він не вдався, запит отримує `503` замість `401`, клієнт повторює — і запис доходить. Ба більше, кожен refresh будь-яким токеном сімʼї, відкликаної менш ніж 10 хв тому, ставить `deny:sid` ще раз, тож запис доходить навіть тоді, коли саме той запит, що виявив повтор (часто злодійський), ніхто не повторить. Відкликання комітиться до того, як запит отримає `401` (кидок усередині транзакції відкотив би його). Ротація без сімʼї нічого не дає: злодій рефрешиться першим, чесний клієнт мовчки перелогінюється, а сесія злодія живе далі. RFC 9700 §4.14.2 вимагає або sender-constrained refresh-токен, або ротацію з детекцією повтору — і в другому випадку звʼязок між старим і новим токеном (`family_id`) зберігається саме для того, щоб виявлений повтор було чим відкликати.

**Гонка на клієнті.** Вікна благодаті немає: повторне предʼявлення того самого refresh — завжди компрометація. Тому клієнт серіалізує рефреш — один спільний проміс на всі паралельні запити, які отримали `401`; решта чекають на нього, а не йдуть рефрешити самі.

### Чому логаут — це дві дії

Refresh-токен — рядок у базі: щоб убити його, досить `revoked_at` на всю сімʼю. Access-токен self-contained: сервер перевіряє лише підпис і `exp`, тож без денилиста він живе до `exp`, хоч би що сталося з сімʼєю. `POST /v1/auth/logout` робить обидва: (1) `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = :sid` у Postgres; (2) `SET deny:jti:<jti> EX <залишок життя>` і `SET deny:sid:<sid> EX <до revoked_at + 600 с>` у noeviction-Redis. Ключі денилиста зникають самі: TTL дорівнює залишку життя токена і ні секундою більше — кожен access-токен сімʼї виданий до її відкликання, тож жоден не живе довше за `revoked_at + 10 хв`. `JwtAuthGuard` перевіряє обидва ключі одним `EXISTS`; якщо Redis недоступний — `503`, а не `401` (fail closed, але без петлі рефрешу).

Це два сховища, тобто dual write (як у ДЗ #22), і атомарним він не є. Порядок вибрано під повтор: спершу Postgres, потім Redis; обидва записи ідемпотентні, а `204` повертається лише після обох. Якщо впав Redis, клієнт отримує `503` і повторює логаут — і повтор проходить гард, бо саме денилист не записався. Вікно між кроками — refresh уже мертвий, access ще живий — закривається повтором або `exp` (≤ 10 хв).

### 401 проти 403

| Ситуація                                               | Код   | Хто вирішує                               |
| ------------------------------------------------------ | ----- | ----------------------------------------- |
| немає токена, зіпсований підпис, протух, чужий `kid`, у денилисті | `401` | `JwtAuthGuard` (глобальний, `@Public()` — виняток) |
| токен валідний, роль не та                             | `403` | `RolesGuard` + `@Roles(...)`              |
| токен валідний, ресурс чужий                           | `403` | `OrdersService` після завантаження        |

Клієнтський SDK на `401` іде рефрешити, на `403` показує помилку, тому їх не можна плутати. Обидва гарди зареєстровані як `APP_GUARD` в `AppModule` — нові маршрути закриті, доки їх явно не позначено `@Public()`.

**Де межа власності.** Власність навмисно не гард: гард стоїть до того, як ресурс завантажено, і щоб дізнатися власника, мусив би сам піти в базу. Перевірка живе в `OrdersService.loadAuthorizedOrder`: замовлення читається одним запитом разом із покупцем і продавцем товару, і тільки тоді `caller.id` порівнюється з `orders.user_id` (покупець) або `products.seller_id` (продавець); admin бачить усе. Невідомий id — `404`, чужий — `403`. Фільтр `WHERE user_id = :caller` прямо в запиті теж коректний, але чуже замовлення тоді виглядало б як `404`.

**Роль у токені — кеш, а не джерело правди.** Свіжо-розжалуваний адмін лишається адміном до `exp` свого access-токена — до 10 хвилин. Наступний `refresh` перечитує користувача з бази й видає токен уже з новою роллю; деактивований користувач (`is_active = false`) на refresh отримує `401`, а його сімʼя відкликається. Якщо 10 хвилин — забагато, сімʼю можна прибити примусово (той самий `deny:sid`). Ресурсні перевірки (власність, «активний покупець» у `POST /v1/orders`) і так дивляться в базу, а не в claim.

**Відомі межі.** WebSocket перевіряє токен один раз, у socket.io-middleware на рукостисканні (`handshake.auth.token`): зʼєднання, відкрите до логауту, живе далі. SSE `GET /orders/{id}/events` вимагає `Authorization`, якого нативний `EventSource` не шле — потрібен fetch-клієнт. Redis-сесія з `POST /v1/sessions` переживає JWT-логаут. На `POST /v1/auth/login` ще немає ліміту спроб.

### Демо

Кожне демо саме піднімає застосунок у своєму процесі на своєму порту (`demo:auth` — 3401, `demo:reuse` — 3402, `demo:rbac` — 3403), тож сирітський сервер, який тримав би порт після вбитого по таймауту запуску, неможливий. Стан приводиться до чистого: демо створює власних користувачів (`demo-*@shop.local`) зі свіжим випадковим паролем і чистить лише їхні замовлення, товари й refresh-токени. Інваріант перевіряється в самому скрипті: будь-яке відхилення — рядок `invariant broken: …` і `exit 1`.

| Демо         | Вивід                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `demo:auth`  | `login=200` `no-token=401` `with-token=200` `refresh=200` `logout=204` `after-logout=401` `refresh-after-logout=401` |
| `demo:reuse` | `login=200` `r1-refresh=200` `r1-reuse=401` `r2-after-reuse=401`                                              |
| `demo:rbac`  | `anon=401` `own=200` `foreign=403` `role-denied=403` `role-allowed=201` `tampered=401`                        |

`after-logout=401` — доказ денилиста: без нього той самий access-токен працював би до `exp`. `r2-after-reuse=401` — доказ сімʼї: після повтору `r1` вилетів і чесний клієнт зі свіжим `r2`; якщо прибрати відкликання сімʼї, тут буде `200` і `demo:reuse` завершиться з `exit 1`. `tampered=401` — payload з `role: admin` під старим підписом; рішення на `jwt.decode()` віддало б `201`.

## Files

Шлях файла: прийняти → зберегти → віддати. Сервіс лишається в шляху авторизації, але не в шляху даних: він підписує URL і звіряє результат, а байти йдуть напряму в S3-сумісне сховище (локально — MinIO з `docker-compose.yaml`, порт `19000`). Коли скасувати дію дорого або неможливо, робимо так, щоб скасування не знадобилося: presigned не відкликається — тому він короткий; запис у CDN не дістати — тому URL версійний; обрив не попередити — тому завантаження відновлюване.

### Змінні

| Змінна                                  | Джерело                                                  | Навіщо                                                                     |
| --------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `STORAGE_ACCESS_KEY`                    | тільки сховище (#11), Infisical `dev` / `prod`           | ключ доступу до сховища                                                    |
| `STORAGE_SECRET_KEY`                    | тільки сховище (#11), Infisical `dev` / `prod`           | секрет до ключа; без дефолту в Zod-схемі                                   |
| `STORAGE_ENDPOINT`                      | сховище (#11), Infisical `dev`; у грейдера — `export`    | адреса S3 API; порожньо → справжній AWS S3                                 |
| `STORAGE_REGION`                        | сховище (#11), Infisical `dev` / `prod`                  | регіон підпису SigV4 (`us-east-1` для MinIO)                               |
| `STORAGE_BUCKET`                        | сховище (#11), Infisical `dev` / `prod`                  | приватний бакет: і `uploads/`, і `assets/`                                 |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `docker-compose.yaml` (дефолти дев-стенда)             | креденшели локального MinIO; секретом не є, як і пароль Postgres у compose |

Нових env-файлів немає: значення живуть у Infisical `dev`, а `demo:upload`, `demo:multipart`, `demo:cdn` ідуть через `bash scripts/with-secrets.sh dev …` — так само, як `migrate` / `seed`. Схема `storageEnvSchema` (`src/config/env.schema.ts`) не має дефолтів для ключів. Ціна витоку тут інша, ніж у `DB_URL`: ключ сховища — це право читати й писати всі файли всіх користувачів з будь-якої точки інтернету, а приватний ключ підпису CDN (якщо дійде до signed URL, див. нижче) — право видати собі доступ до всього приватного контенту дистрибуції.

### Двокроковий контракт

1. `POST /v1/uploads/intent` `{ filename, content_type, size }` → `200`. Маршрут закритий глобальним `JwtAuthGuard` з ДЗ #24. `content_type` перевіряється за allowlist (`image/png`, `image/jpeg`, `image/webp`, `application/pdf`, `application/gzip`), і розширення береться з нього. Ключ генерує сервер: `uploads/{userId}/{uuid}.{ext}`. `filename` у ключ не потрапляє — інакше клієнт міг би писати за будь-яким шляхом у бакеті (`demo:upload` шле `../../etc/passwd` і перевіряє `key-from-server=1`). У `files` зʼявляється рядок `PENDING`.
2. Клієнт кладе байти за presigned URL напряму у сховище. Підпис покриває ключ (підмінений ключ → `403 SignatureDoesNotMatch`) і `Content-Type` — SDK за замовчуванням його не підписує, тому `signableHeaders: ['content-type']`.
3. `POST /v1/uploads/{id}/commit` → `HeadObject`. Обʼєкта немає → `409`; розмір не збігається з заявленим у intent → `409`. Лише після звірки — `COMPLETED`. Presigned PUT довжину тіла не обмежує (`UNSIGNED-PAYLOAD`), тож звірка розміру живе саме тут. Повторний commit завершеного файла — `200`.

Таблиця `files` — звичайна міграція `1790600000000-AddFiles`: `key` (unique), `owner_id`, `status`, `size`, `upload_id`, `content_type`. Список файлів користувача читається з бази, а не листингом бакета: листинг платний, повільний і віддає 1 000 ключів за виклик. У лог іде `fileId` і ключ, ніколи сам URL — presigned і є носієм доступу.

Content-Type від клієнта — це його слова. Якщо тип важливий, наступний крок — перевірка magic bytes на commit (`GetObject` з `Range: bytes=0-255`); сканування вмісту — Лекція 27.

### Строк presigned

- **PUT — 300 с.** Сценарій — аватарка чи фото товару з форми: URL видається в момент натискання «Завантажити», і клієнт одразу ж робить PUT. S3 перевіряє строк на початку запиту, тому повільне завантаження, яке стартувало вчасно, доїде; пʼять хвилин покривають кілька ретраїв на поганій мобільній мережі. Відкликати presigned неможливо — ні `jti`, ні реєстру, — тож короткий строк єдиний важіль із чотирьох стратегій ДЗ #24, який тут працює.
- **Частини multipart — 900 с.** `GET /v1/uploads/{id}/parts` перевипускає URL на все, чого бракує, тож довгий строк не потрібен навіть для великого файла.
- **Не 7 діб.** Це технічна межа SigV4, але presigned помирає разом із креденшелами, якими підписаний, а прод ходить у сховище під STS-роллю (типово 1 год). Для посилання, яке відкриють пізніше (лист), — не presigned у тексті, а `GET /files/:id` → `302` на свіжий URL на хвилину: гард працює на кожен запит (план, у цьому ДЗ не реалізовано).

`expired=403` у `demo:upload` — той самий підписант `presignPut`, TTL = 1 с, пауза 3 с, той самий URL.

### Multipart: поріг і розмір частини

- **Розмір частини** `partSize = max(5 MiB, ⌈size / 10 000⌉ до цілого MiB)` (`src/uploads/upload-policy.ts`). 5 MiB — мінімум S3 для всіх частин, крім останньої (інакше Complete → `EntityTooSmall`); 10 000 — максимум частин. Жорсткі 5 MiB впали б на файлі понад ~48,8 GiB; формула для 100 GiB дає 11 MiB × 9 310 частин.
- **Поріг — 10 MiB (2 × 5 MiB).** Менше двох частин — нічого довантажувати: обрив єдиної частини це обрив усього файла. До порогу — один PUT, понад — `CreateMultipartUpload` і підписані `UploadPart`. Стеля — 100 GiB.
- **Відновлення.** Клієнт завжди починає з `GET /v1/uploads/{id}/parts`: сервер робить `ListParts` (з пагінацією — 1 000 частин на сторінку) і повертає номери, що вже лежать, плюс свіжі URL лише на відсутні. Документація S3 перелічує чотири переваги multipart — пропускна здатність, швидке відновлення після мережевих збоїв, пауза й продовження, старт до того, як відомий розмір, — і про розмір файла лише одна.
- **Complete** бере ETag частин із серверного `ListParts`, а не від клієнта: браузер без CORS `ExposeHeaders: ETag` його навіть не прочитає.
- **ETag multipart-обʼєкта** — MD5 від склеєних MD5 частин із суфіксом `-N`, а не MD5 файла. Код «порівняю ETag з локальним MD5» на multipart ламається мовчки; `etag-multipart=1` перевіряє саме це.

### Незавершені завантаження й файли-сироти

Незавершений multipart тарифікується, хоча обʼєкта немає і в консолі його не видно. Штатна гігієна бакета — lifecycle:

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "Filter": { "Prefix": "uploads/" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
```

Правило `Expiration` «видаляти старше 30 днів» таких хвостів не чіпає — це різні дії. Рядки `PENDING` старші за добу добиває джоба (план, BullMQ з ДЗ #23): `AbortMultipartUpload` → `DeleteObject` → видалити рядок. Бекап із ДЗ #15 тепер теж їде в бакет, і lifecycle робить його дешевим; але Glacier ламає RTO (обʼєкт спершу треба відновити), а lifecycle не робить бекап перевіреним — restore-drill лишається.

### CDN: обрана форма — локальний edge

`src/cdn/edge.ts` — маленький edge на `node:http`: `GET /assets/…` → кеш у памʼяті → на промаху `GetObject` клієнтом SDK зі **своїми** креденшелами → відповідь із власним `X-Cache: HIT|MISS`. Це і є суть OAC: до сховища ходить кеш, а не публіка. Бакет приватний — анонімний GET прямо у сховище дає `403`. Edge роздає лише префікс `assets/`: інакше приватні `uploads/{userId}/…` стали б публічними через кеш. Кешує тільки те, що дозволив origin (`max-age > 0`, без `no-store` / `no-cache` / `private`): заголовок ставиться на обʼєкт під час завантаження, а не в edge.

### Bucket policy для AWS-варіанту (CloudFront + OAC)

Block Public Access увімкнено повністю; дистрибуція ходить в origin через Origin Access Control (підпис SigV4 «always»). Читати дозволено лише сервісу CloudFront і лише від імені **нашої** дистрибуції — без `Condition` на `AWS:SourceArn` доступ отримала б будь-яка дистрибуція у світі:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOACReadAssets",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::hw26-files/assets/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::111122223333:distribution/EDFDVBD6EXAMPLE"
        }
      }
    }
  ]
}
```

`Resource` обмежений `assets/*` з тієї ж причини, що й префікс в edge. Запис у `uploads/` іде лише presigned-URL від ролі застосунку.

### Оновлення без інвалідації

`publishAsset` (`src/cdn/publish-asset.ts`) кладе ассет під імʼям із хешем вмісту — `assets/app.<sha256[0..8]>.css` — і з `Cache-Control: public, max-age=31536000, immutable` на самому обʼєкті. Після «деплою» новий вміст отримує нове імʼя, тобто новий URL; старий запис у кеші нікому не заважає (`old-url-hit=1`), інвалідацій — нуль. AWS про інвалідацію каже прямо: для файлів, які часто оновлюються, рекомендує передусім версіонування файлів, а не інвалідацію. Контроль у демо — `assets/app.css` без `Cache-Control`: edge його не кешує (`no-cache-control-hit=0`); саме так виглядає `cache-hit=0`, коли заголовок забули поставити при завантаженні.

**Приватний контент (план).** Те, що не можна віддавати всім (куплені файли, документи), CloudFront роздає за signed URL або signed cookies: edge перевіряє підпис ключем із trusted key group, бакет лишається закритим тим самим OAC. Приватний ключ підпису живе лише у сховищі (#11) поруч із `STORAGE_*`.

### Демо

Кожне демо саме приводить стан до чистого і бере свій порт: `demo:upload` — API на 3421, після зупинки — на 3422 (глобальний `fetch` тримає пул зʼєднань на парі host:port, тож рестарт на тому самому порту може дістати мертвий сокет); `demo:multipart` — 3423; `demo:cdn` — edge на 3431. Живість порту перевіряється сирим `net.connect`. Дочірні процеси (PUT без нас, завантажувач частин) отримують дані через stdin — presigned URL у argv побачив би кожен `ps` — і оточення лише з `PATH`. Відхилення від інваріанта — рядок `invariant broken: …` і `exit 1`.

- **`demo:upload`.** Чистить файли свого акаунта (`demo-upload@shop.local`) — і рядки, і обʼєкти під `uploads/{id}/`. Intent з `../../etc/passwd` → підмінений ключ у URL → intent без байтів одразу на commit → **зупинка API** → PUT окремим процесом без жодного ключа → API на новому порту → commit → URL з TTL 1 с через 3 с.
- **`demo:multipart`.** Чистка: `AbortMultipartUpload` для незавершених завантажень (за рядками `files` і `ListMultipartUploads`), обʼєкти, рядки. Детермінований файл 12 MiB → intent → три частини по 5 + 5 + 2 MiB. Перший процес заливає дві й помирає від `SIGKILL`; другий питає `/parts`, бачить `[1, 2]` і доливає одну. `HeadObject` до commit → `404`, після → розмір і ETag `-3`. Проходить двічі поспіль.
- **`demo:cdn`.** Чистить `assets/`, піднімає edge, публікує `app.<hash>.css`, бʼє анонімно прямо в бакет, двічі через edge, «деплоїть» новий вміст.

Власні числа (три прогони поспіль на чистому `docker compose up`):

```text
# npm run demo:upload  → exit 0
intent=200
key-from-server=1
tampered=403
commit-without-bytes=409
api-alive=0
put-offline=200
offline-credential-vars=0
commit=200
expired=403

# npm run demo:multipart  → exit 0 (прогін 1; прогін 2 — ті самі числа)
part-count=3
crashed=1
resumed-parts=1
head-before-complete=404
complete=200
size-match=1
etag-multipart=1

# npm run demo:cdn  → exit 0
direct=403
edge-miss=200
edge-hit=200
cache-hit=1
new-name=1
new-url=200
content-changed=1
old-url-hit=1
no-cache-control-hit=0
```

`api-alive=0` + `put-offline=200` — байти доїхали, поки застосунок був вимкнений, і їх ніс процес без жодного ключа (`offline-credential-vars=0`); проксі через бекенд дав би тут `0`. `commit-without-bytes=409` — без `HeadObject` було б `200`. `resumed-parts=1` — без `ListParts` другий процес залив би всі `3`. `direct=403` + `cache-hit=1` — бакет закритий для публіки й відкритий для кеша; `new-name=1` + `content-changed=1` — оновлення новим URL, а не інвалідацією; мутабельне `app.css` дало б `0` і `0`.

## Grading

```bash
docker compose up -d --wait
export DB_HOST=127.0.0.1 DB_PORT=6432 DB_USER=admin DB_PASSWORD=admin-secret DB_NAME=shop
export DB_URL=postgres://admin:admin-secret@127.0.0.1:6432/shop
export PORT=3000
export BROKER_URL=amqp://app:app@127.0.0.1:5672 # ← схема amqp, порт AMQP (не 15672)
export REDIS_URL=redis://127.0.0.1:16379        # кеш, порт як у compose (redis-cache)
export REDIS_QUEUE_URL=redis://127.0.0.1:16380  # черга / сесії / ліміт / денилист (redis-queue)
export SKIP_VAULT=1    # у грейдера немає доступу до сховища
export STORAGE_ENDPOINT=http://127.0.0.1:19000   # MinIO з compose (S3 API)
export STORAGE_REGION=us-east-1
export STORAGE_ACCESS_KEY=hw26user
export STORAGE_SECRET_KEY=hw26secretpass
export STORAGE_BUCKET=hw26-files               # демо створюють бакет самі

# одноразова пара ES256 (EC P-256) для прогону; PEM їде в base64, щоб багаторядковість не поїхала
node -e 'const {generateKeyPairSync}=require("node:crypto");
const k=generateKeyPairSync("ec",{namedCurve:"P-256",
  privateKeyEncoding:{type:"pkcs8",format:"pem"},
  publicKeyEncoding:{type:"spki",format:"pem"}});
const fs=require("node:fs");
fs.writeFileSync("/tmp/priv.b64",Buffer.from(k.privateKey).toString("base64"));
fs.writeFileSync("/tmp/pub.b64",Buffer.from(k.publicKey).toString("base64"));'
export JWT_KID=grader
export JWT_PRIVATE_KEY="$(cat /tmp/priv.b64)"
export JWT_PUBLIC_KEY="$(cat /tmp/pub.b64)"
export REFRESH_TOKEN_PEPPER="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"

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
npm run demo:publish
npm run demo:dlq
npm run demo:duplicate
npm run demo:outbox
npm run demo:crash-write
npm run demo:crash-relay
npm run demo:cache
npm run demo:session
npm run demo:ratelimit
npm run demo:queue
npm run demo:auth
npm run demo:reuse
npm run demo:rbac
npm run demo:upload
npm run demo:multipart
npm run demo:multipart
npm run demo:cdn
```

Застосунку байдуже, чия це пара, аби вона була валідна, тому справжній ключ лишається у сховищі, а грейдер генерує свій на місці. `REFRESH_TOKEN_PEPPER` — випадкові 32 байти: схема не прийме коротший.

Скрипти `backup.sh` / `restore-drill.sh` читають `DATABASE_URL` з оточення; `with-secrets.sh` при `SKIP_VAULT=1` не ходить у Infisical і просто виконує команду.

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://admin:admin-secret@127.0.0.1:6432/shop
export SKIP_VAULT=1    # у грейдера немає доступу до сховища
bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

## Тестування

Драбина довіри (ДЗ #16): integration на справжньому Postgres у Testcontainers, E2E через supertest і контракт Pact з брокером.

### Команди

```bash
npm run test:integration   # Product / Order / CheckoutService проти Postgres
npm run test:e2e           # POST /v1/orders → GET + 404
npm run test:contract      # consumer → генерує pacts/*.json
npm run verify:provider    # справжній Nest проти контракту
```

Каталог `pacts/` створює `test:contract` (і CI теж). Він у `.gitignore` — у git не комітимо згенеровані файли.

Happy path E2E: `POST /v1/orders` пише замовлення через `CheckoutService`, а `GET /v1/orders/:id` читає його з Postgres (`orders` + `order_items`). Невідомий id теж виконує `SELECT` і відповідає 404.

### Ізоляція integration-suite

Кожен Jest-файл піднімає свій контейнер `postgres:16-alpine` (registry модулів ізольований між файлами); між тестами всередині файлу — `TRUNCATE … RESTART IDENTITY CASCADE`. Стратегія ROLLBACK не підходить: `CheckoutService` комітить власну TypeORM-транзакцію іншим клієнтом пулу, тож зовнішній `BEGIN`/`ROLLBACK` її не скасує. Повторний `npm run test:integration` зелений без ручної чистки БД.

### Pact Broker локально

```bash
docker compose up -d --wait
npm run test:contract
```

Два легальні шляхи верифікації провайдера:

```bash
# основний: URL і токен з Infisical env dev
bash scripts/with-secrets.sh dev npm run verify:provider

# форма грейдера / локальний compose без сховища.
# Брокер auth не вимагає — токена в команді немає, exit 0.
# Непорожній PACT_BROKER_TOKEN теж дає exit 0.
SKIP_VAULT=1 PACT_BROKER_URL=http://127.0.0.1:9292 PACT_PROVIDER_VERSION=1.0.0 \
  npm run verify:provider
```

Код читає лише `process.env.PACT_BROKER_URL` / `PACT_BROKER_TOKEN`. Ключ `pactBrokerToken` потрапляє в Verifier тільки з непорожнім значенням: `undefined` або `''` валить прогон (`TypeError: pactBrokerToken`). Локальний брокер auth не вимагає, тож форма грейдера вище завершується з exit 0; з непорожнім токеном — теж exit 0. У Infisical `dev` заведи ці ключі (і за потреби `PACT_PROVIDER_VERSION`); значення в репозиторій не клади. Без `PACT_BROKER_URL` `verify:provider` читає локальний `pacts/*.json` і нічого не публікує.

### can-i-deploy: unknown → true

Порядок кроків фіксований. `to=prod` питає, чи є успішна верифікація проти версії провайдера з тегом `prod`.

```bash
export PACT_BROKER_URL=http://127.0.0.1:9292

curl -s -o /tmp/pact-publish.body -w '%{http_code}\n' \
  -X PUT \
  "$PACT_BROKER_URL/pacts/provider/marketplace-api/consumer/marketplace-frontend/version/1.0.0" \
  -H 'Content-Type: application/json' \
  --data-binary @pacts/marketplace-frontend-marketplace-api.json
# очікуємо 201

PACT_PROVIDER_VERSION=1.0.0 npm run verify:provider

# ДО тега prod — гейт чесно каже «невідомо»
curl -s "$PACT_BROKER_URL/can-i-deploy?pacticipant=marketplace-frontend&version=1.0.0&to=prod"
```

```json
{
  "summary": {
    "deployable": null,
    "reason": "There is no verified pact between version 1.0.0 of marketplace-frontend and the latest version of marketplace-api with tag prod (no such version exists)",
    "success": 0,
    "failed": 0,
    "unknown": 1
  },
  "notices": [
    {
      "type": "error",
      "text": "There is no verified pact between version 1.0.0 of marketplace-frontend and the latest version of marketplace-api with tag prod (no such version exists)"
    }
  ],
  "matrix": [
    {
      "consumer": {
        "name": "marketplace-frontend",
        "version": {
          "number": "1.0.0",
          "branch": null,
          "branches": [],
          "branchVersions": [],
          "environments": [],
          "_links": {
            "self": {
              "href": "http://127.0.0.1:9292/pacticipants/marketplace-frontend/versions/1.0.0"
            }
          },
          "tags": []
        },
        "_links": {
          "self": {
            "href": "http://127.0.0.1:9292/pacticipants/marketplace-frontend"
          }
        }
      },
      "provider": {
        "name": "marketplace-api",
        "version": null,
        "_links": {
          "self": {
            "href": "http://127.0.0.1:9292/pacticipants/marketplace-api"
          }
        }
      },
      "pact": {
        "createdAt": "2026-10-01T10:53:10+00:00",
        "_links": {
          "self": {
            "href": "http://127.0.0.1:9292/pacts/provider/marketplace-api/consumer/marketplace-frontend/version/1.0.0"
          }
        }
      },
      "verificationResult": null
    }
  ]
}
```

```bash
curl -s -o /tmp/pact-tag.body -w '%{http_code}\n' \
  -X PUT \
  "$PACT_BROKER_URL/pacticipants/marketplace-api/versions/1.0.0/tags/prod" \
  -H 'Content-Type: application/json'
# очікуємо 201

# ПІСЛЯ тега — можна деплоїти консюмера
curl -s "$PACT_BROKER_URL/can-i-deploy?pacticipant=marketplace-frontend&version=1.0.0&to=prod"
```

```json
{
  "summary": {
    "deployable": true,
    "reason": "All required verification results are published and successful",
    "success": 1,
    "failed": 0,
    "unknown": 0
  },
  "notices": [
    {
      "type": "success",
      "text": "All required verification results are published and successful"
    }
  ],
  "matrix": [
    {
      "consumer": {
        "name": "marketplace-frontend",
        "version": {
          "number": "1.0.0",
          "branch": null,
          "branches": [],
          "branchVersions": [],
          "environments": [],
          "_links": {
            "self": {
              "href": "http://127.0.0.1:9292/pacticipants/marketplace-frontend/versions/1.0.0"
            }
          },
          "tags": []
        },
        "_links": {
          "self": {
            "href": "http://127.0.0.1:9292/pacticipants/marketplace-frontend"
          }
        }
      },
      "provider": {
        "name": "marketplace-api",
        "version": {
          "number": "1.0.0",
          "branch": "prod",
          "branches": [
            {
              "name": "prod",
              "latest": true,
              "_links": {
                "self": {
                  "title": "Branch version",
                  "name": "prod",
                  "href": "http://127.0.0.1:9292/pacticipants/marketplace-api/branches/prod/versions/1.0.0"
                }
              }
            }
          ],
          "branchVersions": [
            {
              "name": "prod",
              "latest": true,
              "_links": {
                "self": {
                  "title": "Branch version",
                  "name": "prod",
                  "href": "http://127.0.0.1:9292/pacticipants/marketplace-api/branches/prod/versions/1.0.0"
                }
              }
            }
          ],
          "environments": [],
          "_links": {
            "self": {
              "href": "http://127.0.0.1:9292/pacticipants/marketplace-api/versions/1.0.0"
            }
          },
          "tags": [
            {
              "name": "prod",
              "latest": true,
              "_links": {
                "self": {
                  "href": "http://127.0.0.1:9292/pacticipants/marketplace-api/versions/1.0.0/tags/prod"
                }
              }
            }
          ]
        },
        "_links": {
          "self": {
            "href": "http://127.0.0.1:9292/pacticipants/marketplace-api"
          }
        }
      },
      "pact": {
        "createdAt": "2026-10-01T10:53:10+00:00",
        "_links": {
          "self": {
            "href": "http://127.0.0.1:9292/pacts/provider/marketplace-api/consumer/marketplace-frontend/version/1.0.0"
          }
        }
      },
      "verificationResult": {
        "success": true,
        "verifiedAt": "2026-10-01T10:55:18+00:00",
        "_links": {
          "self": {
            "href": "http://127.0.0.1:9292/pacts/provider/marketplace-api/consumer/marketplace-frontend/pact-version/257f135cb40f33a37a4020801f93ef1ade339c13/metadata/Y3ZuPTEuMC4w/verification-results/102"
          }
        }
      }
    }
  ]
}
```

Тег `prod` ставиться на версію **провайдера** (`marketplace-api`), і вона має збігатися з `PACT_PROVIDER_VERSION` у Verifier. CI-job `contract` у `.github/workflows/contract.yml`: publish → verify → `can-i-deploy`.
