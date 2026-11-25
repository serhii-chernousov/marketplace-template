# Marketplace API — курсовий проєкт Node.js PRO

Backend маркетплейсу на NestJS: покупець оформлює замовлення на товари продавця, система резервує товар і кошти, підтверджує оплату у фоні через RabbitMQ і повідомляє власника замовлення наживо. Проєкт зібраний із проєктних ДЗ курсу; що звідки і чим замінено — у таблиці [Блок → шлях](#блок--шлях--чим-замінено).

## Швидкий старт для рев'юера

Потрібні Docker (Compose v2) і Node.js 22 (лише для демо-скриптів на хості).

```bash
git clone <repo> && cd marketplace-template
docker compose up -d --wait   # postgres, pgbouncer, rabbitmq, 2×redis, minio, prometheus, jaeger, grafana, migrate, seed, api, worker
npm ci
npm run demo:contour          # головний контур наживо
```

Очікуваний вивід `demo:contour` (exit 0):

```text
order=order-1
created=pending
after-consumer=paid
replay-same-order=1
skip-to-delivered=409
ship=200 deliver=200
final=delivered
```

Жодних ручних кроків: ключі JWT генерує одноразовий сервіс `keygen` при першому старті, міграції й seed — сервіси `migrate` і `seed`, `api` чекає їх (`service_completed_successfully`) і всіх залежностей (`service_healthy`). Дані Postgres, RabbitMQ і черги Redis лежать у named volumes і переживають `docker compose restart` / `down` без `-v`.

Якщо порт 3000 зайнятий: `API_PORT=3300 docker compose up -d --wait`, далі `BASE_URL=http://localhost:3300 npm run demo:contour`.

| Що                 | Де                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| API                | `http://localhost:3000` (`/healthz`, `/readyz`, `/metrics`)                                                                |
| OpenAPI            | [`openapi/openapi.yaml`](openapi/openapi.yaml)                                                                             |
| Grafana (RED)      | `http://localhost:22900` (admin/admin, dev-only)                                                                           |
| Jaeger             | `http://localhost:22904`                                                                                                   |
| Prometheus         | `http://localhost:22901`                                                                                                   |
| RabbitMQ           | `http://localhost:15672` (app/app, dev-only)                                                                               |
| Сідові користувачі | `buyer1..5@shop.local`, `seller1..2@shop.local`, `admin@shop.local`; пароль — `SEED_PASSWORD` (локально `marketplace-dev`) |

### Демо-скрипти поза контуром

`demo:contour` і `demo:realtime` ходять у запущений API по HTTP. Решта демо — лабораторні скрипти, що працюють з БД, брокером і Redis напряму з хоста. Їм потрібні ті самі dev-значення, що в compose; `scripts/dev-env.sh` друкує їх як `export`:

```bash
eval "$(bash scripts/dev-env.sh)"   # dev-значення compose + JWT-ключі з volume keygen
npm run build
npm run demo:race
```

Messaging-демо (`demo:outbox`, `demo:crash-write`, `demo:crash-relay`, `demo:duplicate`, `demo:dlq`, `demo:publish`) самі скидають черги й запускають власні relay і consumer. Живий consumer API забрав би їхні повідомлення, тож скрипт відмовляється стартувати (exit 2), поки він підключений. Перед ними: `MESSAGING_ENABLED=0 docker compose up -d --wait api`, після — `docker compose up -d --wait api`.

## Архітектурна записка

### Домен

Marketplace: продавці виставляють товари з обмеженим залишком, покупці з балансом оформлюють замовлення. Основна сутність — **замовлення** з життєвим циклом:

```text
pending ──(споживач order.placed)──▶ paid ──▶ shipped ──▶ delivered
   │                                  │
   └────────────▶ cancelled ◀─────────┘      (скасування повертає товар і кошти)
```

`pending → paid` робить лише система (споживач події), решту переходів — продавець замовлення або admin через `PATCH /v1/orders/{id}/status`. Недозволений перехід — `409` problem+json.

### Перевірка домену

| #   | Вимога до домену                                            | Чим закрито в Marketplace                                                                                        |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Основна сутність має життєвий цикл, а не лише CRUD          | `Order`: `pending → paid → shipped → delivered`, `cancelled`; правила переходів у `OrdersService`                |
| 2   | Є обмежений ресурс, за який конкурують одночасні запити     | `products.stock` і `users.balance_cents`: атомарний `UPDATE … WHERE stock >= n`, `demo:race` (50 спроб)          |
| 3   | Є незворотна операція, повтор якої не має дати другий ефект | checkout списує товар і гроші; `Idempotency-Key` + `idempotency_keys`, `eventId` похідний від id замовлення      |
| 4   | Є робота, яку варто винести з запиту у фон                  | підтвердження оплати через outbox → RabbitMQ → споживач; перерахунок картки товару в BullMQ-воркері              |
| 5   | Є ролі й власність ресурсу                                  | buyer / seller / admin; замовлення бачать лише його покупець, продавець його товарів і admin                     |
| 6   | Є подія, яку власник має отримати наживо                    | `order.status` у кімнату socket.io `orders:<id>` і SSE з `Last-Event-ID`; чужий `join` відхиляється              |
| 7   | Є read-heavy дані, які треба віддавати швидко               | картка товару: cache-aside у Redis із TTL-джитером і single-flight; індекси за `EXPLAIN` (`db/OPTIMIZATIONS.md`) |

### Головний наскрізний контур

Сценарій «оформлення замовлення»: `POST /v1/orders` → `pending` → фонове підтвердження → `paid` → продавець відвантажує → `delivered`. Перевірка однією командою — `npm run demo:contour`, автотест — [`test/e2e/order-contour.e2e.spec.ts`](test/e2e/order-contour.e2e.spec.ts).

| Ланка                     | Як реалізовано                                                                                                                                                                   | Доказ                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1. Клієнт викликає API    | `POST /v1/orders` з `Authorization: Bearer` і обов'язковим `Idempotency-Key`                                                                                                     | `npm run demo:contour`                                     |
| 2. Валідація              | `express-openapi-validator` за `openapi/openapi.yaml` (запити й відповіді), помилки — `application/problem+json`                                                                 | запит без `Idempotency-Key` → `400`                        |
| 3. Права доступу          | `JwtAuthGuard` → 401, `RolesGuard` (`@Roles('buyer')`) → 403, власність — у `OrdersService.loadAuthorizedOrder`                                                                  | `npm run demo:rbac`, e2e                                   |
| 4. Бізнес-логіка          | `CheckoutService`: одна транзакція — `UPDATE products … WHERE stock >= n`, списання балансу, замовлення, позиції, рядок `outbox`; нестача → rollback усього                      | `npm run demo:race`                                        |
| 5. Збереження             | Postgres через PgBouncer (transaction mode), схема під міграціями TypeORM                                                                                                        | `docker compose restart api` → ті самі замовлення          |
| 6. Фонова обробка         | `OrderMessagingService` в API: relay `outbox` (`FOR UPDATE SKIP LOCKED`, confirm-канал) → `shop.order.placed` → споживач (ack після ефекту, дедуп у Postgres) → `pending → paid` | `after-consumer=paid` у `demo:contour`                     |
| 7. Повторне читання       | `GET /v1/orders/{id}`, `GET /v1/orders` (keyset-курсор), SSE `/orders/{id}/events`, socket.io                                                                                    | `final=delivered`                                          |
| 8. Логи й моніторинг      | pino JSON з `trace_id` і `layer`; RED-метрики з шаблоном `route` у Prometheus/Grafana; трейс у Jaeger                                                                            | Grafana `:22900`, Jaeger `:22904`                          |
| 9. Автотест               | e2e на справжніх Postgres і RabbitMQ (testcontainers): `pending → paid` рівно один раз, replay, 409/403                                                                          | `npm run test:e2e`                                         |
| 10. Розгорнуте середовище | локально — compose; кластер — Pulumi → kind (міграції Job-ом, rolling update `failed=0`)                                                                                         | `npm run cluster:up && npm run up && npm run demo:rollout` |

### Схема

```mermaid
flowchart LR
  client([Клієнт]) -->|HTTP + JWT| api
  client <-->|socket.io / SSE| api
  subgraph api [api: NestJS]
    ctrl[Controllers] --> svc[Services] --> repo[Repositories / SQL]
    relay[Outbox relay]
    consumer[order.placed consumer]
  end
  repo --> pgb[(PgBouncer)] --> pg[(Postgres)]
  relay -->|SKIP LOCKED| pgb
  relay -->|confirm publish| mq[[RabbitMQ]]
  mq -->|manual ack| consumer --> pgb
  api --> rc[(Redis cache, allkeys-lru)]
  api --> rq[(Redis queue, noeviction)]
  rq --> worker[worker: BullMQ] --> rc
  api -->|presigned URL| s3[(MinIO)]
  api -->|OTLP| jaeger[Jaeger]
  prom[Prometheus] -->|/metrics| api
  grafana[Grafana] --> prom
```

```mermaid
sequenceDiagram
  participant B as Buyer
  participant A as API
  participant DB as Postgres
  participant R as Relay
  participant MQ as RabbitMQ
  participant C as Consumer
  B->>A: POST /v1/orders (Idempotency-Key)
  A->>DB: BEGIN · UPDATE stock · UPDATE balance · INSERT order(pending) · INSERT outbox · COMMIT
  A-->>B: 201 {status: pending}
  R->>DB: SELECT … FOR UPDATE SKIP LOCKED
  R->>MQ: publish order.placed (confirm)
  R->>DB: UPDATE outbox SET published_at
  MQ->>C: deliver
  C->>DB: BEGIN · INSERT processed_messages ON CONFLICT · INSERT effect · UPDATE order → paid · COMMIT
  C->>MQ: ack
  C-->>B: socket.io / SSE order.status = paid
  B->>A: GET /v1/orders/{id}
  A-->>B: {status: paid}
```

### Trade-offs

- **Transactional outbox.** Обрав запис події в `outbox` тією ж транзакцією, що й замовлення, бо бізнес-запис і подія мають з'явитись разом або не з'явитись взагалі; інакше publish після commit губить подію при падінні між ними, а publish до commit шле подію про замовлення, якого може не бути.
- **Оплата у фоні.** Обрав `pending → paid` споживачем, бо `POST /v1/orders` лишається короткою транзакцією і не падає, коли брокер недоступний; інакше лежачий RabbitMQ ламав би оформлення замовлень. Ціна — клієнт бачить `pending` і дочитує статус окремим запитом або через realtime.
- **Атомарний UPDATE.** Обрав `UPDATE … WHERE stock >= n RETURNING`, бо перевірка залишку й запис — одна операція з row-lock; інакше `SELECT` + арифметика в JS дає oversell під 50 одночасними запитами, а явний `SELECT … FOR UPDATE` довший і легше зламати.
- **Дедуп у Postgres.** Обрав `processed_messages` + `ON CONFLICT DO NOTHING` в одній транзакції з ефектом, бо дедуп має пережити рестарт і бути спільним для реплік; інакше `Set` у пам'яті пропускає дубль після рестарту споживача.
- **PgBouncer у transaction mode.** Обрав його, бо 8 серверних з'єднань обслуговують до 200 клієнтів; інакше кожна репліка тримала б свій пул і впиралась у `max_connections`. Ціна — немає сесійного стану (`SET`, `LISTEN`, сесійні advisory locks), тому міграції йдуть напряму в Postgres.
- **ES256 + непрозорий refresh.** Обрав короткий JWT ES256 і refresh-токен у БД з денилистом у Redis, бо access перевіряється без БД, а логаут і відкликання сім'ї все одно працюють; інакше або сесія в БД на кожен запит, або вкрадений токен живе до експірації.
- **Два Redis.** Обрав окремі інстанси (`allkeys-lru` для кешу, `noeviction` для черги, сесій і лімітів), бо витіснення кешу не має забирати задачі; інакше під тиском пам'яті BullMQ губить джоби, а сесії зникають.
- **Realtime у процесі API.** Обрав in-memory шину і кімнати socket.io, бо так подія від споживача доходить до клієнта без ще одного брокера; інакше потрібен Redis-адаптер. Межа: на двох репліках клієнт, підключений до іншого поду, подію не отримає (див. [Realtime](#realtime-дз-18)).
- **Міграції окремим кроком.** Обрав Job у k8s і сервіс `migrate` у compose, бо `typeorm migration:run` не бере advisory lock; інакше кілька подів під час rollout запускали б міграції одночасно.

### Журнал рішень

| Коли          | Було                                                                     | Стало                                                                                              | Чому                                                                 |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| ДЗ 6 → ДЗ 9   | Замовлення й оголошення в пам'яті для контракту OpenAPI                  | Postgres + TypeORM, міграції з відкатом, ідемпотентний seed                                        | дані мають переживати рестарт                                        |
| ДЗ 10         | `SELECT` залишку + запис                                                 | атомарний `UPDATE … WHERE stock >= n`; retry лише на `40001` / `40P01`                             | oversell під конкуренцією; повтор constraint-помилок шкідливий       |
| ДЗ 14 → ДЗ 15 | Publish одразу після checkout (два commit)                               | transactional outbox + relay на `SKIP LOCKED`, дедуп ефекту в БД                                   | падіння між commit і publish губило подію                            |
| ДЗ 16         | Fail-open Redis з дефолтними таймаутами (4 збої з 13 при лежачому Redis) | `connectTimeout: 1000`, `commandTimeout: 500`, `enableOfflineQueue: false` — 0 збоїв               | запит чекав переподключення довше, ніж клієнт                        |
| ДЗ 17         | Ідентифікація через `X-User-Id` / `X-User-Role`                          | ES256 JWT, ротація refresh із відкликанням сім'ї, 401 vs 403                                       | заголовок підробляє будь-хто                                         |
| ДЗ 19         | Secret з фіксованим ім'ям (delete + create на ротації)                   | авто-імена Secret/ConfigMap → звичайний rolling update                                             | кожна ротація давала даунтайм                                        |
| Курсовий      | Checkout одразу писав `paid`; relay і consumer запускались лише з демо   | `pending` → relay і consumer у процесі API ставлять `paid`; eventId похідний від id замовлення     | фонова частина мусить бути в живому контурі, а не лише в демо        |
| Курсовий      | `GET /v1/orders` читав пам'ять процесу; статуси мінялись без правил      | список із Postgres (keyset-курсор); таблиця переходів, `409`, скасування повертає товар і кошти    | після рестарту список був порожній; `cancelled → paid` було можливим |
| Курсовий      | У compose лише залежності; запуск API вимагав ручних кроків              | `keygen`, `migrate`, `seed`, `api`, `worker` у compose, одна команда `docker compose up -d --wait` | відтворюваний запуск для рев'юера                                    |

## Блок → шлях → чим замінено

✅ — реалізовано й доведено командою, ⚠️ — частково, ❌ — немає.

| Блок | Властивість                                     | Шлях                                              | Чим замінено і чому                                                                                      | Стан                                      | Чим показати                                                                              |
| ---- | ----------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| 11.1 | Архітектурна записка                            | курсу (ДЗ 0)                                      | —                                                                                                        | ✅                                        | цей розділ                                                                                |
| 11.1 | Шари controller → service → repository          | курсу (ДЗ 9, ДЗ 20)                               | поле `layer` у логах: `orders.controller`, `orders.service`, `orders.repo`, `checkout.repo`, `messaging` | ✅                                        | `npm run demo:logs`; логи `docker compose logs api`                                       |
| 11.1 | Конфіг зі схемою, падіння на старті             | курсу (ДЗ 7: ConfigModule + zod)                  | —                                                                                                        | ✅                                        | без `JWT_KID` → exit 1 з назвою змінної; `npm run check:env`                              |
| 11.1 | Схема, API-опис, runbook                        | —                                                 | Mermaid у README                                                                                         | ✅                                        | [Схема](#схема), `openapi/openapi.yaml`, [Швидкий старт](#швидкий-старт-для-ревюера)      |
| 11.1 | OWASP Top 10:2025 (+)                           | —                                                 | —                                                                                                        | ✅                                        | [OWASP](#owasp-top-102025)                                                                |
| 11.2 | Повний контур                                   | курсу (checkout + outbox + RabbitMQ)              | —                                                                                                        | ✅                                        | `npm run demo:contour`                                                                    |
| 11.2 | Бізнес-правило під конкуренцією                 | курсу (ДЗ 10: атомарний UPDATE)                   | —                                                                                                        | ✅                                        | `npm run demo:race`: 50 спроб, 10 успішних, stock 0                                       |
| 11.2 | Контракт, який звіряє машина                    | курсу (ДЗ 6, варіант Б + Pact з ДЗ 12)            | `express-openapi-validator` з `validateResponses: true`                                                  | ✅                                        | `npm run lint:openapi`; `npm run test:contract && npm run verify:provider`                |
| 11.2 | Повтор не дає другого ефекту                    | курсу (ДЗ 15)                                     | ключ `(user_id, Idempotency-Key)` в `idempotency_keys`; eventId — UUIDv5-подібний від `order-<id>`       | ✅                                        | `replay-same-order=1`; `npm run demo:outbox`                                              |
| 11.3 | Схема з констрейнтами, міграції, seed           | курсу (ДЗ 8, ДЗ 9: TypeORM)                       | —                                                                                                        | ✅                                        | `npm run migrate:revert && npm run migrate`; seed двічі                                   |
| 11.3 | Продуктивність виміряна                         | курсу (ДЗ 8, ДЗ 9)                                | —                                                                                                        | ✅                                        | `db/OPTIMIZATIONS.md` (EXPLAIN до/після); `npm run demo:nplus1`                           |
| 11.3 | Пулер, бекап, RTO/RPO                           | курсу (ДЗ 11: PgBouncer, pg_dump)                 | —                                                                                                        | ✅                                        | `bash scripts/restore-drill.sh` → MATCH; `RESTORE-DRILL.md`; `SHOW POOLS` → `transaction` |
| 11.3 | Кеш і сесії                                     | курсу (ДЗ 16: два Redis)                          | —                                                                                                        | ⚠️ рестарт сесії не показано скриптом     | `npm run demo:cache`; `npm run demo:session`                                              |
| 11.3 | Файли повз сервіс                               | курсу (ДЗ 18)                                     | MinIO + локальний edge з `X-Cache` замість CloudFront                                                    | ✅                                        | `npm run demo:upload`; `npm run demo:cdn`                                                 |
| 11.4 | Автентифікація                                  | курсу (ДЗ 17)                                     | ES256 замість RS256 (рекомендація OWASP)                                                                 | ✅                                        | `npm run demo:reuse`                                                                      |
| 11.4 | Авторизація, 401 vs 403, realtime лише власнику | курсу (ДЗ 17, ДЗ 13)                              | —                                                                                                        | ✅                                        | `npm run demo:rbac`; `npm run demo:realtime`                                              |
| 11.4 | Валідація, єдиний формат помилок                | курсу (ДЗ 6, варіант Б)                           | —                                                                                                        | ✅                                        | запит без `Idempotency-Key` → 400 problem+json                                            |
| 11.4 | Секрети поза кодом                              | курсу (ДЗ 7, ДЗ 19)                               | dev-значення compose лише для локального стенда                                                          | ✅                                        | `git check-ignore -v .env`; `npm run demo:image` → `token-in-*=0`                         |
| 11.4 | Захист краю                                     | курсу (ДЗ 16)                                     | —                                                                                                        | ⚠️ rate-limit є, вебхука провайдера немає | `npm run demo:ratelimit` → 429 + `Retry-After`                                            |
| 11.4 | Сховище секретів (+)                            | курсу (ДЗ 7: Infisical)                           | —                                                                                                        | ⚠️                                        | `bash scripts/with-secrets.sh dev\|prod …`                                                |
| 11.5 | Реальна фонова частина                          | курсу (ДЗ 14 RabbitMQ, ДЗ 16 BullMQ)              | —                                                                                                        | ✅                                        | `after-consumer=paid` у `demo:contour`                                                    |
| 11.5 | Подія не губиться й не дублює ефект             | курсу (ДЗ 14, ДЗ 15)                              | —                                                                                                        | ✅                                        | `demo:crash-write`, `demo:crash-relay`, `demo:duplicate`, `demo:publish` (`prefetch=20`)  |
| 11.5 | Конкурентна обробка, retry, DLQ                 | курсу (ДЗ 10, ДЗ 14, ДЗ 16)                       | —                                                                                                        | ✅                                        | `demo:workers` («оброблено двічі: 0»), `demo:retry`, `demo:dlq`                           |
| 11.5 | Realtime                                        | курсу (ДЗ 13: socket.io + SSE)                    | —                                                                                                        | ✅                                        | `npm run demo:realtime` → `A_RECEIVED=1 B_RECEIVED=0`                                     |
| 11.6 | Локальний запуск однією командою                | курсу (ДЗ 2)                                      | —                                                                                                        | ✅                                        | `docker compose up -d --wait` з чистого клону                                             |
| 11.6 | Production-образ                                | курсу (ДЗ 19)                                     | distroless `nodejs22:nonroot`, Trivy                                                                     | ✅                                        | `npm run demo:image`; `npm run scan`                                                      |
| 11.6 | Розгортання кодом, rollout `failed=0`           | курсу (ДЗ 19: Pulumi → kind)                      | —                                                                                                        | ✅                                        | `npm run demo:rollout`; `npm run demo:pdb`                                                |
| 11.6 | Розгортання поза локальною машиною              | —                                                 | —                                                                                                        | ❌                                        | —                                                                                         |
| 11.7 | Health: liveness ≠ readiness                    | курсу (ДЗ 19)                                     | —                                                                                                        | ✅                                        | `curl :3000/healthz`; `curl :3000/readyz`                                                 |
| 11.7 | Структурні логи                                 | курсу (ДЗ 20: pino + AsyncLocalStorage)           | —                                                                                                        | ✅                                        | `npm run demo:logs`                                                                       |
| 11.7 | Моніторинг                                      | курсу (ДЗ 20: Prometheus, Grafana, OTel → Jaeger) | —                                                                                                        | ✅                                        | дашборд `observability/grafana/dashboards/red.json`; `demo:metrics`, `demo:trace`         |
| 11.7 | Тести                                           | курсу (ДЗ 12)                                     | —                                                                                                        | ✅                                        | `npm run test:unit`; `npm run test:integration` ×2; `npm run test:e2e`                    |
| 11.7 | Pipeline                                        | курсу (ДЗ 12, ДЗ 22)                              | GitHub Actions без деплою                                                                                | ✅                                        | `.github/workflows/ci.yml`, `contract.yml`, `image-scan.yml`                              |

## Змінні оточення

Схема — [`src/config/env.schema.ts`](src/config/env.schema.ts) (zod), приклад — [`.env.example`](.env.example), звірка — `npm run check:env`. Локально значення бере compose (`x-app-env`, dev-only), `npm start` на хості — `.env` або Infisical через `scripts/with-secrets.sh`, кластер — ConfigMap і Secret, які Pulumi наповнює з Infisical.

| Змінна                                                 | Призначення                                          | Дефолт              | Джерело: compose             | Джерело: kind                           |
| ------------------------------------------------------ | ---------------------------------------------------- | ------------------- | ---------------------------- | --------------------------------------- |
| `PORT`                                                 | HTTP-порт                                            | —                   | compose                      | ConfigMap                               |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME`             | адреса PgBouncer і роль застосунку                   | —                   | compose                      | ConfigMap                               |
| `DB_PASSWORD`, `DB_URL`                                | пароль ролі `app_user`                               | —                   | compose (dev-only)           | Secret ← Infisical                      |
| `BROKER_URL`                                           | RabbitMQ AMQP                                        | —                   | compose (dev-only)           | Secret ← Infisical                      |
| `REDIS_URL`                                            | Redis-кеш (`allkeys-lru`)                            | —                   | compose                      | Secret ← Infisical                      |
| `REDIS_QUEUE_URL`                                      | Redis для черги, сесій, лімітів (`noeviction`)       | —                   | compose                      | Secret ← Infisical                      |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_KID`         | ключ підпису ES256                                   | —                   | `keygen` → volume `jwt-keys` | Secret ← Infisical                      |
| `JWT_EXTRA_PUBLIC_KEYS`                                | старі публічні ключі на час ротації                  | порожньо            | —                            | Secret ← `infra/settings.ts`            |
| `REFRESH_TOKEN_PEPPER`                                 | HMAC refresh-токенів                                 | —                   | `keygen` → volume `jwt-keys` | Secret ← Infisical                      |
| `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET` | S3/MinIO                                             | —                   | compose                      | ConfigMap                               |
| `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`             | доступ до бакета                                     | —                   | compose (dev-only)           | Secret ← Infisical                      |
| `MESSAGING_ENABLED`                                    | relay outbox і споживач `order.placed` у процесі API | `1`                 | compose                      | дефолт                                  |
| `OUTBOX_POLL_MS`                                       | період опитування outbox                             | `500`               | дефолт                       | дефолт                                  |
| `LOG_LEVEL`                                            | рівень логів                                         | `info`              | compose                      | ConfigMap                               |
| `TIMEOUT_MS`                                           | таймаут запиту                                       | `5000`              | дефолт                       | дефолт                                  |
| `WARMUP_MS`, `DRAIN_MS`, `SHUTDOWN_TIMEOUT_MS`         | прогрів і graceful shutdown                          | `0`, `0`, `5000`    | дефолт                       | Deployment env (`4000`, `5000`, `5000`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`     | експорт трейсів                                      | порожньо = вимкнено | compose (Jaeger)             | —                                       |
| `FAULT_INJECTION`                                      | демо 5xx і затримок                                  | `0`                 | дефолт                       | дефолт                                  |
| `CONFIG_ENV_FILE`                                      | додатковий env-файл (ключі від `keygen`)             | —                   | compose                      | —                                       |
| `SEED_PASSWORD`                                        | пароль сідових користувачів (лише seed)              | —                   | compose (dev-only)           | —                                       |
| `API_PORT`                                             | порт API на хості (лише compose)                     | `3000`              | shell                        | —                                       |

## OWASP Top 10:2025

| Категорія                                  | Застосовна | Що зроблено / чому не робимо                                                                                                                                                                                   |
| ------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 Broken Access Control                  | так        | глобальні `JwtAuthGuard` + `RolesGuard`; власність замовлення перевіряє сервіс після завантаження рядка (404 vs 403); `join` у кімнату socket.io лише власнику; `demo:rbac`                                    |
| A02 Security Misconfiguration              | так        | конфіг валідується zod на старті; бакет приватний (анонімний GET → 403); distroless-образ без shell, не root; dev-паролі живуть лише в compose                                                                 |
| A03 Software Supply Chain Failures         | так        | `npm ci` з lock-файлом; Trivy-гейт (`npm run scan`) у CI; actions у `ci.yml` запінені за SHA; токен реєстру лише як build-secret (`token-in-*=0`)                                                              |
| A04 Cryptographic Failures                 | так        | ES256 з явним allowlist алгоритмів, iss/aud; refresh зберігається як HMAC-SHA256 з перцем; паролі — scrypt (`src/auth/password.ts`)                                                                            |
| A05 Injection                              | так        | параметризовані SQL (`$1…`), TypeORM QueryBuilder; вхід перевіряє OpenAPI-валідатор до бізнес-логіки                                                                                                           |
| A06 Insecure Design                        | так        | інваріанти в БД (CHECK, FK), атомарний декремент, ідемпотентність на краю API, явна таблиця переходів статусу                                                                                                  |
| A07 Authentication Failures                | так        | короткий access, ротація refresh з відкликанням сім'ї при повторі, логаут відкликає access і refresh; rate-limit на `POST /v1/sessions` і `POST /v1/orders`. Прогалина: `POST /v1/auth/login` без ліміту спроб |
| A08 Software or Data Integrity Failures    | частково   | події несуть детермінований `eventId`, дедуп у БД; підпису подій немає — брокер внутрішній. Вебхука зовнішнього провайдера немає, тож HMAC над сирим тілом не реалізовано                                      |
| A09 Security Logging and Alerting Failures | частково   | структурні логи з `trace_id`, редакція токенів і паролів, лог відкликання сім'ї; алертингу немає (є SLO-нотатки в розділі Observability)                                                                       |
| A10 Mishandling of Exceptional Conditions  | так        | єдиний problem+json фільтр; транзієнтні помилки споживача → requeue, отрута → DLQ; Redis fail-open з короткими таймаутами; readiness червоніє на SIGTERM                                                       |

## Ресурси

- `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/auth/me` — JWT-автентифікація (див. [Auth](#auth))
- `GET /healthz` (жив), `GET /readyz` (готовий приймати трафік) — проби Kubernetes (див. [Kubernetes](#kubernetes))
- `GET/POST /v1/listings`, `GET/PATCH /v1/listings/{id}`
- `GET /v1/products/{id}`, `POST /v1/products` — картка товару (публічна) і запис у каталог (seller/admin)
- `GET/POST /v1/orders`, `GET /v1/orders/{id}` — create іде в Postgres через `CheckoutService` (статус `pending`), список і get читають Postgres
- `PATCH /v1/orders/{id}/status` — зміна статусу продавцем або admin за таблицею переходів; після commit емітить подію в спільну шину
- `GET /orders/{id}/events` — SSE-потік `order.status` з `id:` і підтримкою `Last-Event-ID`
- WebSocket (socket.io) — `join` у кімнату `orders:<id>` після перевірки власника; подія `order.status` лише в цю кімнату
- `POST /v1/uploads/intent`, `GET /v1/uploads/{id}/parts`, `POST /v1/uploads/{id}/commit` — завантаження файлів повз API за presigned URL, multipart із довантаженням (див. [Files](#files))

Гроші — цілі копійки в API (`price_cents`, `total_cents`) і в SQL (`products.price_cents`, `orders.total_cents`, `order_items.unit_price_cents`). Ідентифікація користувача — лише `Authorization: Bearer <access-токен>`; заголовки `X-User-Id` / `X-User-Role` більше нічого не значать. Без токена відкриті тільки вхід, refresh, перегляд оголошень і карток товарів, `/health`, `/db`. У відповідях сідові акаунти мають короткі id (`buyer-1`, `seller-1`), решта — email.

## Структура `src/`

| Каталог                           | Призначення                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `auth/`                           | JWT ES256, ротація refresh з детекцією повтору, денилист, гарди `JwtAuthGuard` / `RolesGuard` |
| `checkout/`                       | `CheckoutService` — транзакційний checkout і запис у outbox                                   |
| `orders/`, `listings/`, `health/` | Nest feature-модулі (controller + service + gateway)                                          |
| `jobs/`                           | черга `FOR UPDATE SKIP LOCKED`                                                                |
| `database/`                       | CLI DataSource, `DatabaseModule`, `DbService`                                                 |
| `store/`                          | in-memory catalog/idempotency для OpenAPI                                                     |
| `catalog/`                        | `GET /v1/products/:id`: картка товару, cache-aside у Redis                                    |
| `common/`                         | `with-retry`, `asRows`, `sleep`                                                               |
| `demo/`                           | CLI-скрипти гонки / воркерів / retry / N+1 / RabbitMQ / Redis                                 |
| `messaging/`                      | RabbitMQ, transactional outbox, relay, ідемпотентний ефект                                    |
| `queue/`                          | BullMQ: `RatingQueueService` (продюсер), `RatingWorker`                                       |
| `ratelimit/`                      | `@RateLimit` + глобальний guard, ковзне вікно в Redis                                         |
| `redis/`                          | `RedisModule`: клієнти кеша й черги, `CONFIG GET`                                             |
| `session/`                        | `/v1/sessions`, middleware з rolling TTL, `SessionGuard`                                      |
| `storage/`                        | S3-клієнт (MinIO / AWS), presigned PUT і UploadPart                                           |
| `uploads/`                        | intent / parts / commit: allowlist, поріг multipart, HeadObject                               |
| `cdn/`                            | edge з `X-Cache` перед приватним бакетом, ассети з хешем в імені                              |
| `entities/`, `migrations/`        | схема TypeORM                                                                                 |

Realtime-файли в `orders/`: `order-events.service.ts` (шина Subject + буфер), `orders.gateway.ts` (кімнати), `order-events.controller.ts` (SSE). Фонове підтвердження — `messaging/order-messaging.service.ts`. Headless-демо: `npm run demo:realtime`.

## Встановлення

```bash
npm install
```

## Запуск

Повний стенд — `docker compose up -d --wait` (див. [Швидкий старт](#швидкий-старт-для-ревюера)). Для розробки на хості — лише залежності в Docker, застосунок локально:

```bash
docker compose up -d --wait db pgbouncer rabbitmq redis-cache redis-queue minio
npm run build && npm run migrate && npm run seed
npm start              # API, :3000
npm run start:worker   # BullMQ-воркер, без HTTP
```

`npm run migrate`, `seed` і `start:vault` ідуть через `scripts/with-secrets.sh` (Infisical); без сховища — `SKIP_VAULT=1` і змінні з [таблиці](#змінні-оточення) в оточенні або `.env`.

Збірка — `nest build` → `node dist` (`npm start`). Не запускай через `tsx`: декоратор-метадані WebSocket gateway не емітяться.

## Realtime (ДЗ #18)

Передумова: стенд піднятий (`docker compose up -d --wait`). Токени — через `POST /v1/auth/login` сідовими користувачами.

### SSE

```bash
login() { curl -s -X POST http://localhost:3000/v1/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"marketplace-dev\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token'; }
BUYER=$(login buyer1@shop.local); SELLER=$(login seller1@shop.local)

# Content-Type має бути text/event-stream
curl -sN --max-time 2 -D - -o /dev/null -H "Authorization: Bearer $BUYER" \
  http://localhost:3000/orders/order-1/events | grep -i '^content-type'

# Зміна статусу продавцем (події накопичуються в памʼяті процесу — без рестарту між кроками)
curl -s -X PATCH http://localhost:3000/v1/orders/order-1/status \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $SELLER" \
  -d '{"status":"cancelled"}'
# повторний виклик → 409: з cancelled переходів немає

# Пропущені події з id > 0 віддаються одразу після підключення
curl -sN --max-time 2 -H 'Last-Event-ID: 0' -H "Authorization: Bearer $BUYER" \
  http://localhost:3000/orders/order-1/events | grep '^id:' | head -1
```

### Ізоляція кімнат (WebSocket)

Скрипт логіниться як `buyer1`, `buyer2` і `seller1`, створює по замовленню для кожного покупця, чекає `paid`, потім продавець відвантажує замовлення A.

```bash
# B (buyer2) не пускають у кімнату чужого замовлення, і він не чує подію A
npm run demo:realtime; echo "exit=$?"
# B_JOIN_FOREIGN=denied
# A_RECEIVED=1
# B_RECEIVED=0
# exit=0

# контроль: B — другий сокет buyer1 у кімнаті A — чує
npm run demo:realtime -- --same-room; echo "exit=$?"
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

| Демо               | Вихід                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `demo:outbox`      | `requests=2` `orders=1` `outbox=1` `published=1` `deliveries=1` `effect=1` `processed=1` |
| `demo:crash-write` | `write-failed=1` `orders=0` `outbox=0` `published=0` `deliveries=0` `effect=0`           |
| `demo:crash-relay` | `published=1` `deliveries=2` `applied=1` `effect=1` `processed=1`                        |

Exactly-once доставки не існує — це задача двох генералів. Є at-least-once доставка плюс ідемпотентний ефект, і разом вони дають exactly-once результат. `demo:crash-relay` це показує очима: та сама подія доїхала двічі (`deliveries=2`), ефект застосовано один раз (`effect=1`).

## Configuration

Змінні описує Zod-схема `src/config/env.schema.ts`. Контракт для git — `.env.example`; реальний `.env` у `.gitignore` і не потрапляє в Docker-образ. У `.env.example` паролі фейкові.

TypeORM CLI (`src/database/data-source.ts`) читає `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` з `process.env` — їх треба тримати в Infisical `dev` (основний шлях: `infisical run`). Nest HTTP піднімає той самий TypeORM через `DatabaseModule` (`DB_PASSWORD` з Config). `/db` health додатково вміє читати `secrets/db_password` (ДЗ #11) з fallback на `DB_PASSWORD`.

| Змінна            | Обов'язкова        | Опис                                                                        |
| ----------------- | ------------------ | --------------------------------------------------------------------------- |
| `PORT`            | так                | HTTP-порт                                                                   |
| `DB_HOST`         | так                | Хост Postgres (`localhost` для Nest на хості)                               |
| `DB_PORT`         | так                | Порт Postgres                                                               |
| `DB_USER`         | так                | Роль застосунку (`app_user`) або `admin` для CLI грейдера                   |
| `DB_PASSWORD`     | так                | Пароль для TypeORM DataSource (`migrate` / `seed` / `demo` / `report`)      |
| `DB_NAME`         | так                | Ім'я бази (`shop`)                                                          |
| `DB_URL`          | так                | Рядок підключення Nest; джерело — Infisical                                 |
| `BROKER_URL`      | так                | AMQP URL RabbitMQ (`amqp://…@host:5672`); у Infisical `dev` поруч із `DB_*` |
| `REDIS_URL`       | так                | Redis-кеш (`allkeys-lru`)                                                   |
| `REDIS_QUEUE_URL` | так                | Redis без витіснення: черга, сесії, ліміт, денилист токенів                 |
| `LOG_LEVEL`       | ні (дефолт `info`) | `debug` \| `info` \| `warn` \| `error`                                      |
| `TIMEOUT_MS`      | ні (дефолт `5000`) | Таймаут у мс                                                                |

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

### Варіант Б (на запущеному стенді)

```bash
BUYER=$(login buyer1@shop.local)   # login() — з розділу Realtime

# без Idempotency-Key → 400 problem+json
curl -s -i -X POST http://localhost:3000/v1/orders \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $BUYER" \
  -d '{"items":[{"listing_id":"listing-1","quantity":1}]}'

# порожній items → 400
curl -s -i -X POST http://localhost:3000/v1/orders \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $BUYER" \
  -H 'Idempotency-Key: key-1' \
  -d '{"items":[]}'

# валідний запит → 201, status=pending
curl -s -i -X POST http://localhost:3000/v1/orders \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $BUYER" \
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

| Змінна                  | Джерело                                   | Навіщо                                                                          |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `JWT_PRIVATE_KEY`       | Infisical (#11), Infisical `dev` / `prod` | підпис access-токенів: base64 від PKCS#8 PEM, EC P-256                          |
| `JWT_PUBLIC_KEY`        | Infisical (#11), Infisical `dev` / `prod` | перевірка підпису: base64 від SPKI PEM тієї ж пари                              |
| `JWT_KID`               | Infisical (#11), Infisical `dev` / `prod` | `kid` у заголовку токена; міняється з кожною ротацією ключа                     |
| `JWT_EXTRA_PUBLIC_KEYS` | Infisical (#11), лише на час ротації      | інші ключі перевірки: `kid:<base64 SPKI PEM>` через кому; поза ротацією порожня |
| `REFRESH_TOKEN_PEPPER`  | Infisical (#11), Infisical `dev` / `prod` | ключ HMAC для `refresh_tokens.token_hash`, ≥ 32 символи                         |
| `DB_HOST` … `DB_NAME`   | compose / оточення                        | дев-креденшели Postgres                                                         |
| `REDIS_QUEUE_URL`       | compose / оточення                        | noeviction-Redis: денилист, сесії, ліміт                                        |

Жодна з чотирьох змінних сховища не має дефолту в Zod-схемі: дефолт для ключа — це ключ, закомічений у git. Ціна витоку тут інша, ніж у `DB_URL`: рядок підключення дає доступ до бази з мережі, а ключ підпису дає змогу виписати собі токен будь-кого, не маючи жодного доступу. Конфіг валідується в `ConfigModule.forRoot` — до `DataSource.initialize()`, тому голий `npm run start` без ключів падає з `exit 1` і називає змінні (`JWT_PRIVATE_KEY: Invalid input…`), а не `ECONNREFUSED`. Схема також перевіряє, що ключі розбираються, що це P-256 і що публічний ключ — пара приватному. `npm run start:vault` і всі `demo:*` йдуть через `bash scripts/with-secrets.sh dev …`. Воркер черги (`start:worker`) валідує лише базову схему: ключа підпису він не тримає.

Пара для оточення генерується локально і йде одразу в сховище, повз файли репозиторію:

```bash
node scripts/jwt-keygen.mjs dev-2026-10    # три рядки KEY=value → Infisical env dev
node scripts/jwt-keygen.mjs prod-2026-10   # → Infisical env prod
bash scripts/with-secrets.sh dev node scripts/jwt-keygen.mjs --fingerprint
bash scripts/with-secrets.sh prod node scripts/jwt-keygen.mjs --fingerprint
```

Відбиток — SHA-256 від SPKI DER публічного ключа; той самий рядок застосунок пише в лог при старті для кожного ключа перевірки (`ES256 verification kid=… fingerprint=…`). Ні токени, ні їхні хвости в лог не йдуть — лише `kid`, відбиток, `family_id`, `user_id`.

| Оточення | `kid`          | Відбиток публічного ключа                             |
| -------- | -------------- | ----------------------------------------------------- |
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

| Ситуація                                                          | Код   | Хто вирішує                                        |
| ----------------------------------------------------------------- | ----- | -------------------------------------------------- |
| немає токена, зіпсований підпис, протух, чужий `kid`, у денилисті | `401` | `JwtAuthGuard` (глобальний, `@Public()` — виняток) |
| токен валідний, роль не та                                        | `403` | `RolesGuard` + `@Roles(...)`                       |
| токен валідний, ресурс чужий                                      | `403` | `OrdersService` після завантаження                 |

Клієнтський SDK на `401` іде рефрешити, на `403` показує помилку, тому їх не можна плутати. Обидва гарди зареєстровані як `APP_GUARD` в `AppModule` — нові маршрути закриті, доки їх явно не позначено `@Public()`.

**Де межа власності.** Власність навмисно не гард: гард стоїть до того, як ресурс завантажено, і щоб дізнатися власника, мусив би сам піти в базу. Перевірка живе в `OrdersService.loadAuthorizedOrder`: замовлення читається одним запитом разом із покупцем і продавцем товару, і тільки тоді `caller.id` порівнюється з `orders.user_id` (покупець) або `products.seller_id` (продавець); admin бачить усе. Невідомий id — `404`, чужий — `403`. Фільтр `WHERE user_id = :caller` прямо в запиті теж коректний, але чуже замовлення тоді виглядало б як `404`.

**Роль у токені — кеш, а не джерело правди.** Свіжо-розжалуваний адмін лишається адміном до `exp` свого access-токена — до 10 хвилин. Наступний `refresh` перечитує користувача з бази й видає токен уже з новою роллю; деактивований користувач (`is_active = false`) на refresh отримує `401`, а його сімʼя відкликається. Якщо 10 хвилин — забагато, сімʼю можна прибити примусово (той самий `deny:sid`). Ресурсні перевірки (власність, «активний покупець» у `POST /v1/orders`) і так дивляться в базу, а не в claim.

**Відомі межі.** WebSocket перевіряє токен один раз, у socket.io-middleware на рукостисканні (`handshake.auth.token`): зʼєднання, відкрите до логауту, живе далі. SSE `GET /orders/{id}/events` вимагає `Authorization`, якого нативний `EventSource` не шле — потрібен fetch-клієнт. Redis-сесія з `POST /v1/sessions` переживає JWT-логаут. На `POST /v1/auth/login` ще немає ліміту спроб.

### Демо

Кожне демо саме піднімає застосунок у своєму процесі на своєму порту (`demo:auth` — 3401, `demo:reuse` — 3402, `demo:rbac` — 3403), тож сирітський сервер, який тримав би порт після вбитого по таймауту запуску, неможливий. Стан приводиться до чистого: демо створює власних користувачів (`demo-*@shop.local`) зі свіжим випадковим паролем і чистить лише їхні замовлення, товари й refresh-токени. Інваріант перевіряється в самому скрипті: будь-яке відхилення — рядок `invariant broken: …` і `exit 1`.

| Демо         | Вивід                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `demo:auth`  | `login=200` `no-token=401` `with-token=200` `refresh=200` `logout=204` `after-logout=401` `refresh-after-logout=401` |
| `demo:reuse` | `login=200` `r1-refresh=200` `r1-reuse=401` `r2-after-reuse=401`                                                     |
| `demo:rbac`  | `anon=401` `own=200` `foreign=403` `role-denied=403` `role-allowed=201` `tampered=401`                               |

`after-logout=401` — доказ денилиста: без нього той самий access-токен працював би до `exp`. `r2-after-reuse=401` — доказ сімʼї: після повтору `r1` вилетів і чесний клієнт зі свіжим `r2`; якщо прибрати відкликання сімʼї, тут буде `200` і `demo:reuse` завершиться з `exit 1`. `tampered=401` — payload з `role: admin` під старим підписом; рішення на `jwt.decode()` віддало б `201`.

## Files

Шлях файла: прийняти → зберегти → віддати. Сервіс лишається в шляху авторизації, але не в шляху даних: він підписує URL і звіряє результат, а байти йдуть напряму в S3-сумісне сховище (локально — MinIO з `docker-compose.yaml`, порт `19000`). Коли скасувати дію дорого або неможливо, робимо так, щоб скасування не знадобилося: presigned не відкликається — тому він короткий; запис у CDN не дістати — тому URL версійний; обрив не попередити — тому завантаження відновлюване.

### Змінні

| Змінна                                    | Джерело                                                 | Навіщо                                                                     |
| ----------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `STORAGE_ACCESS_KEY`                      | тільки Infisical (#11), Infisical `dev` / `prod`        | ключ доступу до S3                                                         |
| `STORAGE_SECRET_KEY`                      | тільки Infisical (#11), Infisical `dev` / `prod`        | секрет до ключа; без дефолту в Zod-схемі                                   |
| `STORAGE_ENDPOINT`                        | Infisical (#11), Infisical `dev`; у грейдера — `export` | адреса S3 API; порожньо → справжній AWS S3                                 |
| `STORAGE_REGION`                          | Infisical (#11), Infisical `dev` / `prod`               | регіон підпису SigV4 (`us-east-1` для MinIO)                               |
| `STORAGE_BUCKET`                          | Infisical (#11), Infisical `dev` / `prod`               | приватний бакет: і `uploads/`, і `assets/`                                 |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `docker-compose.yaml` (дефолти дев-стенда)              | креденшели локального MinIO; секретом не є, як і пароль Postgres у compose |

Нових env-файлів немає: значення живуть у Infisical `dev`, а `demo:upload`, `demo:multipart`, `demo:cdn` ідуть через `bash scripts/with-secrets.sh dev …` — так само, як `migrate` / `seed`. Схема `storageEnvSchema` (`src/config/env.schema.ts`) не має дефолтів для ключів. Ціна витоку тут інша, ніж у `DB_URL`: ключ сховища — це право читати й писати всі файли всіх користувачів з будь-якої точки інтернету, а приватний ключ підпису CDN (якщо дійде до signed URL, див. нижче) — право видати собі доступ до всього приватного контенту дистрибуції.

### Двокроковий контракт

1. `POST /v1/uploads/intent` з заголовком `Idempotency-Key` і тілом `{ filename, content_type, size }` → `200`. Без ключа — `400`. Той самий ключ і те саме тіло повертають той самий рядок `PENDING` і той самий multipart (`Idempotency-Replay: true`), тож подвійний тап не відкриває друге незавершене завантаження. Той самий ключ з іншим тілом — `422`. Маршрут закритий глобальним `JwtAuthGuard` з ДЗ #24. `content_type` перевіряється за allowlist (`image/png`, `image/jpeg`, `image/webp`, `application/pdf`, `application/gzip`), і розширення береться з нього. Ключ обʼєкта генерує сервер: `uploads/{userId}/{uuid}.{ext}`. `filename` у ключ не потрапляє — інакше клієнт міг би писати за будь-яким шляхом у бакеті (`demo:upload` шле `../../etc/passwd` і перевіряє `key-from-server=1`).
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

`src/cdn/edge.ts` — маленький edge на `node:http`: `GET` і `HEAD /assets/…` → кеш у памʼяті → на промаху `GetObject` клієнтом SDK зі **своїми** креденшелами → відповідь із власним `X-Cache: HIT|MISS`. `HEAD` віддає ті самі заголовки, що й `GET`, без тіла. Це і є суть OAC: до сховища ходить кеш, а не публіка. Бакет приватний — анонімний GET прямо у сховище дає `403`. Edge роздає лише префікс `assets/`: інакше приватні `uploads/{userId}/…` стали б публічними через кеш. Кешує тільки те, що дозволив origin (`max-age > 0`, без `no-store` / `no-cache` / `private`): заголовок ставиться на обʼєкт під час завантаження, а не в edge.

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

## Kubernetes

Курсовий живе в локальному одновузловому кластері як справжній деплой: API (`dist/main.js`), воркер черги (`dist/worker.js`), міграції та всі залежності — Postgres, два Redis, RabbitMQ і MinIO. Усе, що їде в кластер, описують дві типізовані Pulumi-програми в `infra/`; руками нічого не застосовується.

**На чому підіймав:** kind v0.33.0 (вузол Kubernetes v1.37.0), Docker Desktop із 7,65 ГіБ памʼяті. Після деплою весь кластер разом із даними й застосунком займає ~1,5 ГіБ (`docker stats --no-stream hw28-control-plane`). Мінімум для прогону — 4 ГіБ у Docker.

### Ресурси

| Що                                                       | Де                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Namespace застосунку                                     | `marketplace`                                                                                    |
| API: Deployment / Service (NodePort `30080`) / PDB / HPA | `marketplace-api`                                                                                |
| Воркер черги                                             | Deployment `marketplace-worker`                                                                  |
| Міграції                                                 | Job `migrate-*` (нове імʼя на кожен деплой)                                                      |
| Секрет рантайму / несекретний конфіг                     | Secret `marketplace-api-secrets-<hash>` / ConfigMap `marketplace-api-config-<hash>` (авто-імена) |
| Сервіси даних                                            | namespace `marketplace-data`: `postgres`, `redis-cache`, `redis-queue`, `rabbitmq`, `minio`      |

### Два стеки — два життєві цикли

|                         | platform (`infra/platform/`)                                              | app (`infra/`)                                        |
| ----------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| Що                      | Postgres, redis-cache, redis-queue, RabbitMQ, MinIO, Job створення бакета | Secret, ConfigMap, migrate Job, API, воркер, PDB, HPA |
| Як часто                | рідко: версія або конфіг сервісу даних                                    | кожен коміт                                           |
| Аналог у хмарі (ДЗ #31) | RDS, ElastiCache, Amazon MQ, S3                                           | EKS                                                   |

App-стек читає адреси через `pulumi.StackReference` і нічого не хардкодить. Деплой застосунку ніколи не перезапускає базу чи брокер: випадковий diff у StatefulSet Redis не може приїхати разом зі зміною в коді.

### Конвеєр одного деплою

`npm run up` → `scripts/deploy.sh`:

1. platform up — ідемпотентний; якщо сервіси даних не змінювались, це no-op.
2. app up: Secret → **migrate Job** (старі поди ще обслуговують трафік) → **rolling update API** → **rolling update воркера**. Pulumi чекає `Complete` у Job, і лише потім чіпає Deployment (`dependsOn`).
3. smoke: `GET /health` через Service має бути `200`. Не `/readyz`: одразу після rollout старий под, що дренується, навмисно відповідає на нього 503, хоча сервіс загалом працює.

Будь-який крок упав — наступні не виконуються, у проді лишається попередня версія. Тег образу — git sha (плюс хеш вмісту, поки є незакомічені зміни у вхідних файлах образу); відкат — `pulumi config set image <попередній тег>` + `up`.

### Змінні

| Змінна                     | Джерело                        | Навіщо                                                                                      |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `DB_PASSWORD`              | сховище (#11), Infisical `dev` | пароль Postgres; платформа ставить його ролі, застосунок і migrate Job беруть із K8s Secret |
| `REDIS_PASSWORD`           | сховище (#11), Infisical `dev` | `requirepass` обох Redis; Pulumi збирає з нього `REDIS_URL` / `REDIS_QUEUE_URL`             |
| `BROKER_PASSWORD`          | сховище (#11), Infisical `dev` | користувач RabbitMQ `app`; Pulumi збирає `BROKER_URL`                                       |
| `STORAGE_ACCESS_KEY`       | сховище (#11), Infisical `dev` | ключ S3 API (MinIO)                                                                         |
| `STORAGE_SECRET_KEY`       | сховище (#11), Infisical `dev` | секрет до ключа S3 API                                                                      |
| `JWT_PRIVATE_KEY`          | сховище (#11), Infisical `dev` | підпис access-токенів (base64 PKCS#8 PEM, P-256)                                            |
| `JWT_PUBLIC_KEY`           | сховище (#11), Infisical `dev` | перевірка підпису (base64 SPKI PEM)                                                         |
| `JWT_KID`                  | сховище (#11), Infisical `dev` | `kid` поточного ключа                                                                       |
| `REFRESH_TOKEN_PEPPER`     | сховище (#11), Infisical `dev` | HMAC-перець refresh-токенів                                                                 |
| `PULUMI_CONFIG_PASSPHRASE` | сховище (#11), Infisical `dev` | ключ шифрування стану Pulumi                                                                |
| `PULUMI_BACKEND_URL`       | `export`, не секрет            | локальний файловий бекенд (`file://$PWD/.pulumi`)                                           |
| `JWT_EXTRA_PUBLIC_KEYS`    | Infisical, лише на час ротації | пробрасується в Secret, якщо задана                                                         |

Значення приїжджають у програму через `scripts/with-secrets.sh` (з `SKIP_VAULT=1` — з оточення). Першою дією обидві програми перевіряють оточення і падають з іменем змінної (`missing required env: DB_PASSWORD`) — ще до `StackReference` і будь-якого звернення до кластера. Дефолтів немає. Deployment бачить секрети лише через `envFrom.secretRef`; адреси сервісів (`DB_HOST`, `STORAGE_ENDPOINT`…) не секретні й лежать у ConfigMap. Secret пишеться через `data` + base64, а не `stringData`: друге `npm run up` поспіль дає `unchanged`.

**Ротація секрету.** Провайдер Kubernetes вважає Secret і ConfigMap незмінними: нове значення означає заміну ресурсу. З фіксованим імʼям це delete + create, і слідом пересоздавались обидва Deployment — тобто даунтайм на кожній ротації (так і було в першій версії). Тепер у них авто-імена: новий Secret створюється до видалення старого, нове імʼя потрапляє в шаблон пода, і Deployment отримує звичайний rolling update. Перевірено: деплой із новою парою JWT-ключів і новим перцем під навантаженням — 6304 запити, `failed=0`.

`Pulumi.dev.yaml` у `.gitignore`: у ньому `encryptionsalt`, привʼязаний до конкретної парольної фрази, і з чужим файлом грейдер отримав би «incorrect passphrase». Дефолти конфігу (`profile`, `rev`) лежать у `Pulumi.yaml`. `pulumi refresh` на app-стеку не робити: він зʼїдає Secret зі стану, наступний `up` падає з `already exists`.

### Образ

`docker/Dockerfile` — чотири стадії: `deps` → `build` → `prod-deps` → `runtime` на `gcr.io/distroless/nodejs22-debian12:nonroot`. Shell у фінальному образі немає, процес — uid 65532. Один образ запускає три процеси: API (`CMD`), воркер і міграції (Pulumi перевизначає `args`).

Токен приватного реєстру — файл-приманка `.npm_token` (у git немає), лише через `RUN --mount=type=secret`. Токен привʼязаний до фіктивного scope `@marketplace-private`, тож npm нікуди його не шле. `.npmrc` створюється й видаляється в одному `RUN`. `npm run demo:image` перевіряє три канали: `docker history`, `docker image inspect` і байти кожного шару з `docker save`. Перевірка детектора на навмисно дірявих збірках:

| Варіант                                      | token-in-history | token-in-config | token-in-layers |
| -------------------------------------------- | ---------------- | --------------- | --------------- |
| `ARG NPM_TOKEN`                              | 2                | 0               | 0               |
| `COPY .npm_token` + `RUN rm` наступним шаром | 0                | 0               | 1               |
| `RUN --mount=type=secret` (наш)              | 0                | 0               | 0               |

### Сканування

`npm run scan` запускає Trivy в контейнері (`aquasec/trivy:0.65.0`, ставити нічого не треба), рахує знахідки `CRITICAL,HIGH` з доступним виправленням (`--ignore-unfixed`) і порівнює з `SCAN_MAX`. Сканер не запустився або звіт не розібрався → `gate=error`, exit 2: пропуску «за замовчуванням» немає. На момент здачі `found=18`: 7 у `libssl3` бази distroless, 11 у npm-залежностях (`body-parser`, `js-yaml`, `lodash`, `multer`…). Робочий поріг — 20, а не 0: база сканера оновлюється щодоби, і нульовий поріг ламав би збірку без жодної зміни в коді. Його ж використовує CI (`.github/workflows/image-scan.yml`), де до сканування ще проганяється `demo:image` з вимогою нуля витоків.

### Проби й SIGTERM

- `startupProbe` → `/healthz` (1 с × 60): поки старт не завершився, liveness і readiness не працюють.
- `readinessProbe` → `/readyz` (кожну 1 с, одна невдача — і под поза Service): «чи можна слати трафік». Відповідає лише за прапорцем процесу, у базу й Redis не ходить.
- `livenessProbe` → `/healthz` (10 с × 3): «чи треба вбити». Інший шлях: тимчасово не готовий застосунок не повинен перезапускатись.

Порядок старту: перевірка схеми (`showMigrations()` — якщо є невиконані міграції, под не стартує) → прогрів `WARMUP_MS=4000` → `listen()` → ready. На SIGTERM: `/readyz` → 503 → дренаж `DRAIN_MS=5000` (kube-proxy прибирає под з endpoints) → `app.close()` (через `SHUTDOWN_TIMEOUT_MS` примусово закриваються SSE і socket.io, які інакше тримали б сокет до SIGKILL) → Redis, TypeORM, AMQP. `terminationGracePeriodSeconds: 20` більший за дренаж плюс закриття. Обробник SIGTERM є в обох профілях: Node у distroless — PID 1, а PID 1 без обробника SIGTERM ігнорує.

### Rolling update під навантаженням

`npm run demo:rollout` міняє `rev` у шаблоні пода (і образ, якщо зібрано новий) і викочує його під навантаженням. `scripts/loadgen.mjs` б'є в `/health` з новим TCP-зʼєднанням на кожен запит і пише в файл код кожної відповіді (`000:<помилка>` — відповіді немає). Уся статистика рахується з цього файла. Ціль — `/health`, бо `/v1/products/:id` має `@RateLimit(120/хв)`, і його 429 рахувались би як збої. Темп обмежено ~250 rps: на macOS порти клієнта висять у TIME_WAIT ~30 с, і вище ~500 нових зʼєднань/с генератор сам вичерпав би порти.

| Профіль                                                         | Прогонів | requests  | failed                                               | rollout-seconds |
| --------------------------------------------------------------- | -------- | --------- | ---------------------------------------------------- | --------------- |
| correct (`maxUnavailable: 0`, `maxSurge: 1`, проби, дренаж 5 с) | 7        | 6072–6240 | **0** у кожному                                      | 15–18           |
| broken (без проб, `maxUnavailable: 1`, без дренажу)             | 5        | ≥ 6000    | 662–1778 (від ~11 до ~29 %; `ECONNRESET` і таймаути) | 5–6             |

Частка збоїв зламаного профілю плаває від прогону до прогону, нуль коректного — ні. Коректний профіль викочується приблизно втричі довше — це ціна нуля: старий под не знімається, поки новий не сказав «готовий», і кожен старий под ще 5 с дренується. `PROFILE=broken npm run demo:rollout` після заміру повертає кластер у correct.

### Міграції під час деплою

- **Окремий Job до rollout, а не старт пода і не initContainer.** `typeorm migration:run` не бере advisory lock: при двох подах і `maxSurge: 1` міграцію запускали б кілька процесів одночасно. Job незмінний, тому новий `rev` чи образ = новий Job; якщо нових міграцій немає, це no-op за ~3 с (`migrate-seconds` у виводі демо).
- **Expand → contract.** Під час rollout стара й нова версії коду працюють на вже новій схемі, тож міграція релізу N лише додає (nullable-колонка, таблиця, індекс `CONCURRENTLY`). Видалення чи перейменування — окремим пізнішим релізом, коли старого коду вже немає. Відкат коду безпечний саме тому, що схема зворотно сумісна; на `migration:revert` у проді не спираємось.
- **Без блокувань.** `migrationsTransactionMode: 'each'`, щоб окрема міграція могла вийти з транзакції (`transaction = false`) заради `CREATE INDEX CONCURRENTLY`, плюс `SET lock_timeout`.

Перевірено на двох сценаріях:

| Сценарій                                                                                            | Що сталось                                                             | requests / failed |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------- |
| Нова міграція `AddProductsSlug` (колонка `slug` + унікальний індекс `CONCURRENTLY`) у новому образі | Job застосував її під навантаженням (8 → 9 міграцій), далі rollout     | 6120 / **0**      |
| Образ із навмисно зламаною міграцією                                                                | Job `Failed`, `pulumi up` exit 1, Deployment лишився на старому образі | 5344 / **0**      |

### Зміни в Redis, RabbitMQ, S3

Зміна буває трьох типів, і в кожної свій шлях.

**Інфраструктурна** (версія чи конфіг Redis, `maxmemory-policy`, версія Postgres) — це platform-стек, окремий `npm run platform:up`, не частина деплою застосунку. У хмарі керований сервіс перемикається на репліку за секунди; локально StatefulSet просто перезапускається, і застосунок мусить це пережити. Кеш карток і rate limit працюють у режимі fail-open (помилка Redis → читання з Postgres / пропуск ліміту), readiness від Redis не залежить. `npm run demo:platform-blip` перезапускає обидва Redis під навантаженням:

| Потік                                                   | requests  | failed |
| ------------------------------------------------------- | --------- | ------ |
| `/health` (~250 rps): чи лишаються поди в Service       | 3800–3960 | 0      |
| картка товару з кешу Redis (1 rps): чи працює fail-open | 17        | 0      |
| рестартів подів API                                     | —         | 0      |

Шлях до нуля на картці — два виправлення в клієнті Redis, і обидва варто знати:

1. Перший прогін дав 4 збої з 13 запитів. Fail-open спрацьовував, але ioredis чекав зʼєднання до дефолтних 10 с, і клієнт відвалювався раніше. Виправлення: `connectTimeout: 1000`, `commandTimeout: 500`.
2. Далі лишались поодинокі таймаути: при лежачому Redis один запит робить три послідовні звернення (rate limit → кеш → лок), і кожне чекало в offline-черзі ioredis, поки йде переподключення. Виправлення: `enableOfflineQueue: false` — без зʼєднання команда падає одразу, і запит миттєво йде в Postgres. Клієнти ліниві (`lazyConnect` потрібен тестам), тому API і воркер підключаються явно на старті (`connectRedisClients`); Redis, лежачий на старті, не фатальний.

Після обох — 0 збоїв у трьох прогонах поспіль. Fail-open без таймаутів — той самий даунтайм, тільки повільніший.

**Зміна формату даних** — деплой застосунку за правилом expand → contract:

| Сервіс         | Expand (реліз N)                                                                                                                                  | Contract (пізніше)                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Postgres       | migrate Job до rollout, лише додаємо                                                                                                              | видалити старе, коли старого коду немає                                 |
| Redis cache    | новий префікс ключа (`product-card:v2:`); старий код читає v1, новий — v2                                                                         | v1 зникає сам за TTL                                                    |
| Redis sessions | новий код читає обидва формати, пише новий                                                                                                        | прибрати читання старого                                                |
| BullMQ         | воркер вчиться читати новий payload раніше, ніж API почне його слати (поле `version`)                                                             | API переходить на новий формат, старий прибирається після дренажу черги |
| RabbitMQ       | толерантний консюмер ігнорує невідомі поля; нові exchange і черги оголошуються ідемпотентно (`assertExchange` / `assertQueue`) до першого publish | старі binding і черги — окремим релізом                                 |
| S3             | бакет або префікс створює платформа (Job `minio-bucket`), застосунок бакетів не створює                                                           | старі обʼєкти — lifecycle-правилом                                      |

**Топологія** (нова черга, бакет, інстанс Redis): спершу платформа, потім застосунок починає цим користуватись. Ніколи навпаки.

### PDB

`minAvailable: 1` при двох репліках → `disruptionsAllowed=1`: вузол можна дренувати, але не обидва поди одразу. `npm run demo:pdb` викликає Eviction API через `kubectl proxy` і друкує справжні HTTP-коди: `evict-1=201`, `evict-2=429` (заміна першого пода ще прогрівається). `minAvailable == replicas` дав би `disruptionsAllowed=0` і заблокував би будь-який drain. Звичайний `kubectl delete pod` PDB не зупиняє: бюджет діє лише на Eviction API.

### HPA і `replicas`

HPA — `autoscaling/v2`, 2–5 реплік, CPU 70 %. У kind немає metrics-server, тому HPA показує `cpu: <unknown>/70%` і нічого не масштабує — саме тому `spec.replicas: 2` у програмі лишається. У бойовому кластері з metrics-server це конфлікт володіння полем: у `spec.replicas` пишуть і Pulumi (server-side apply), і контролер HPA. Кожен `pulumi up` або скидав би масштаб, який вибрав HPA, або падав би на конфлікті field manager. Там `replicas` треба прибрати з програми (або `ignoreChanges: ['spec.replicas']`), лишивши кількість реплік лише HPA.

### Секрети: межі

- **ESO / CSI.** У проді секрет не проходить через ноутбук розробника. External Secrets Operator за розкладом синхронізує Vault / Infisical / AWS Secrets Manager у K8s Secret; Secrets Store CSI Driver монтує секрет у под файлом напряму зі сховища (опційно синхронізуючи в Secret). Тут ту ж роль грає Pulumi з `with-secrets.sh`; оператор не ставимо.
- **base64 — не шифрування.** Без `EncryptionConfiguration` значення лежить у etcd відкритим текстом. «Поклав у Secret» означає «прибрав із git», а не «зашифрував».
- **Два різні секрети.** BuildKit-секрет живе лише під час `docker build` і захищає образ і реєстр; K8s Secret живе в рантаймі й захищає репозиторій. Жоден не замінює інший.

### startupProbe (бонус)

Без `startupProbe` до першого рестарту є `initialDelaySeconds + periodSeconds × failureThreshold` = 0 + 10 × 3 = **30 с**. Повільна міграція чи прогрів довше за це перетворюються на нескінченний цикл рестартів, а збільшений `initialDelaySeconds` сповільнює виявлення справжнього зависання назавжди. З `startupProbe` (1 с × 60) застосунок має **60 с** на старт. Типовий старт тут — ~5 с (з них 4 с прогріву). Щойно startup пройшов, він вимикається, і liveness знову реагує за 30 с.

### Відомі обмеження

- SSE-події й кімнати socket.io живуть у памʼяті процесу: з двома подами клієнт пода A не почує подію з пода B. Потрібні `@socket.io/redis-adapter` і події в Redis.
- Outbox relay і `OrderPlacedConsumer` запускаються лише з демо; у проді це окремі Deployment (relay безпечний у кількох репліках завдяки `FOR UPDATE SKIP LOCKED`).
- Спрощення платформи: `POSTGRES_USER` — суперкористувач (у проді — owner-роль для міграцій і DML-роль для рантайму), MinIO під root-ключем, без TLS. Postgres і RabbitMQ беруть пароль лише при першій ініціалізації тому: зміна значення на живому кластері лікується `npm run destroy && npm run cluster:down`.
- `STORAGE_ENDPOINT` — внутрішня адреса MinIO, тож presigned URL, підписані в кластері, ззовні не відкриються; для них потрібен Ingress до MinIO.
- `kind load docker-image` падає з `content digest … not found` на Docker зі сховищем образів containerd. `scripts/cluster-up.sh` тоді імпортує образ однієї платформи через `ctr`.

## Observability

Питання розділу: «о 03:15 один запит віддав 500 — що сталося?». Відповідь шукаємо за одним ключем. `trace_id` активного спана OpenTelemetry є в кожному рядку логу, у спані в Jaeger і в заголовку `traceparent`, з яким запит прийшов. Метрики RED показують, коли й на якому маршруті почалося.

### Як це влаштовано

- **OpenTelemetry**: [`src/observability/otel.ts`](src/observability/otel.ts) — **перший імпорт** `main.ts` і `worker.ts`. Автоінструментування патчить `http`, `express`, `pg`, `ioredis` у момент `require`, тому все, що завантажилось раніше, лишилось би без спанів. Вхідний `traceparent` продовжується (W3C Trace Context, `parentbased_always_on`). Серверний спан відповіді 5xx отримує статус `ERROR` (на 4xx лишається `Unset`), а [`ProblemExceptionFilter`](src/filters/problem-exception.filter.ts) додає в спан `recordException` і пише рядок `request failed`. Без `OTEL_EXPORTER_OTLP_ENDPOINT` SDK не стартує. На SIGTERM `shutdownTelemetry()` скидає батч спанів.
- **Контекст запиту**: [`request-context.ts`](src/observability/request-context.ts) — `AsyncLocalStorage` з `tenant` (заголовок `x-tenant-id`, типово `public`: окремих тенантів у домені немає), `idempotencyKey` (заголовок `Idempotency-Key`, ДЗ #22) і `userId` (його ставить `JwtAuthGuard` після перевірки токена, ДЗ #24). `trace_id` в ALS **не лежить**: його єдине джерело — активний спан.
- **Логи**: [`logger.ts`](src/observability/logger.ts) — pino, один JSON на рядок у stdout. `mixin` додає в кожен рядок `trace_id`, `span_id`, `userId`, `tenant` і `idempotencyKey`. Жодна функція не приймає `req` заради логування. Шари — модульні `logger.child({ layer })`: `orders.controller` → `orders.service` → `orders.repo` ([`OrderRepository`](src/orders/order.repository.ts)) / `checkout.repo`, плюс `http` (access-log) і `nest` (логи самого Nest через [`PinoNestLogger`](src/observability/nest-logger.ts)). Усі `console.*` у рантаймі замінені логером, тож не-JSON рядків у stdout немає.
- **Redaction**: `redact` ховає лише ті шляхи, які в ньому описані: `*.password` покриває один рівень вкладеності, і `{ user: { credentials: { password } } }` протече. Тому тіла запитів не логуються взагалі, а заголовки `authorization`, `cookie` та `x-session-id` ховаються явними шляхами. Обидва випадки зафіксовані в [`logger.spec.ts`](src/observability/logger.spec.ts).
- **Метрики**: [`metrics.ts`](src/observability/metrics.ts) і [`http-observability.ts`](src/observability/http-observability.ts) — Express-middleware, а не interceptor. Він стоїть перед пайплайном Nest і бачить також відповіді гардів (401/403/429) та OpenAPI-валідатора (400/405). `route` — це шаблон: `req.route.path`, якщо обробник знайдено, інакше шаблон зі специфікації (`req.openapi.openApiRoute`), інакше `unmatched`. Сирого шляху там не буває ніколи. `status` — справжній HTTP-код. `GET /metrics` — `@Public()`, виключений з OpenAPI-валідатора.
- **Детермінований 5xx для демо**: [`FaultInjection`](src/common/fault-injection.ts). Він вимкнений, поки не задано `FAULT_INJECTION=1`. З ним заголовок `x-fault: 500` на `POST /v1/orders` вмикає вже наявний `failAfterOutbox`: транзакція checkout падає після справжніх SQL і відкочується. На `GET /v1/orders/:id` той самий заголовок кидає помилку після запиту до бази. `x-fault-delay-ms` (≤ 3000) робить повільну відповідь.

### Змінні

| Змінна                                          | Хто читає                                                  | Джерело                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                   | застосунок (`otel.ts`)                                     | Infisical `dev` через `scripts/with-secrets.sh`; у грейдера — `export` (`http://127.0.0.1:22918`)                        |
| `OTEL_SERVICE_NAME`                             | застосунок                                                 | дефолт у zod-схемі (`marketplace-api`)                                                                                   |
| `FAULT_INJECTION`                               | застосунок                                                 | дефолт `0`; демо запускають застосунок з `1`                                                                             |
| `LOG_LEVEL`                                     | логер                                                      | дефолт `info`; демо запускають з `debug` (рядки шарів пишуться на `debug`)                                               |
| `PROMETHEUS_URL`                                | `demo:metrics` (інформаційний ключ `prometheus-target-up`) | Infisical `dev`; у грейдера — `export` (`http://127.0.0.1:22901`)                                                        |
| `TRACE_API_URL`                                 | `demo:trace` (Jaeger `/api/traces/<id>`)                   | Infisical `dev`; у грейдера — `export` (`http://127.0.0.1:22904`)                                                        |
| `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | Grafana в `observability/compose.yaml`                     | Infisical `dev` (`bash scripts/with-secrets.sh dev docker compose up -d --wait`); без сховища — дефолт `admin` / `admin` |

Нових env-файлів немає. Змінні застосунку додані в zod-схему й `.env.example` (`npm run check:env`).

### Стенд

[`observability/compose.yaml`](observability/compose.yaml) підключений у кореневий `docker-compose.yaml` через `include`, тож `docker compose up -d --wait` з кореня піднімає його разом з усім іншим.

| Сервіс         | Порт                                              | Що там                                                                                                                                    |
| -------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Grafana 12.1   | `22900`                                           | дашборд «Marketplace API — RED». Датасорси Prometheus і Jaeger провіжаться з [`grafana/provisioning`](observability/grafana/provisioning) |
| Prometheus 3.5 | `22901`                                           | скрейпить `host.docker.internal:3000` (`npm start`) і порти демо `3411–3413` кожні 5 с                                                    |
| Jaeger 2.8     | `22918` → OTLP/HTTP, `22904` → UI і `/api/traces` | in-memory сховище трейсів                                                                                                                 |

`docker stats --no-stream` до і після підняття стенда (Docker Desktop, 7,65 GiB):

|                                                                                     | Пам'ять         |
| ----------------------------------------------------------------------------------- | --------------- |
| До: 7 контейнерів курсового (db, pgbouncer, rabbitmq, 2× redis, minio, pact-broker) | ≈ 549 MiB       |
| Стенд: Grafana 129,3 MiB + Prometheus 21,9 MiB + Jaeger 13,6 MiB                    | **+ 164,8 MiB** |
| Після                                                                               | ≈ 714 MiB       |

`up -d --wait` для стенда зайняв 12 с. Годинники хоста й контейнера збігаються (`date +%s` = `docker run --rm alpine date +%s`). Стенд лишає великий запас до ліміту Docker разом із kind-кластером з ДЗ #28.

### Дашборд: три питання RED

Файл [`observability/grafana/dashboards/red.json`](observability/grafana/dashboards/red.json). Вікно `[1m]`, бо демо триває хвилину, а `[5m]` розмазав би сплеск.

| Панель   | Питання                            | PromQL                                                                                                             |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Rate     | Скільки запитів за секунду і куди? | `sum by (route) (rate(http_requests_total{route!="/metrics"}[1m]))`                                                |
| Errors   | Яка частка відповідей — 5xx?       | `sum by (route) (rate(http_requests_total{status=~"5.."}[1m])) / sum by (route) (rate(http_requests_total[1m]))`   |
| Duration | Скільки чекає 95 % запитів?        | `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{route!="/metrics"}[1m])))` |

### Бакети гістограми

`0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` секунд.

- Нижня частина (5–100 мс) — це звичайні запити: `GET /v1/orders/:id` має p95 ≈ 21 мс.
- Середня (0,25–2,5 с) — повільні шляхи: checkout із ретраями `withRetry`, демо-затримки 1,5 і 2,5 с.
- Верхній скінченний `le=10` = 2 × `TIMEOUT_MS` (5000 мс). Запит не живе довше за таймаут, тож найгірший випадок завжди нижче за 10 с, і `histogram_quantile` не впирається в останній бакет саме тоді, коли все погано. Демо це перевіряє: `above-top-bucket=0` при двох навмисно повільних запитах.

### Демо і мої числа

Кожне демо запускає застосунок окремим процесом `node dist/main.js` на своєму порту (`3411` / `3412` / `3413`) з `FAULT_INJECTION=1` і `LOG_LEVEL=debug`. Його stdout і є потік логів, який перевіряється, і він не змішується з виводом `ключ=число`. Стан чиститься на старті: демо-акаунти пересоздаються, а їхні замовлення стираються (`resetDemoAccounts`). Інваріанти демо перевіряють самі й завершуються з кодом ≠ 0, якщо щось порушено.

**`npm run demo:logs`** — корелятор живе в контексті:

1. Один `GET /v1/orders/:id` з `traceparent`. Усі рядки, що з'явились за час запиту, мають один `trace_id`, рівний trace-id із заголовка. Шарів чотири: `orders.controller`, `orders.service`, `orders.repo`, `http`.
2. 12 однакових запитів паралельно, у кожного свій `traceparent`. Пул TypeORM — 10 з'єднань, тож частина запитів чекає з'єднання. Рядки групуються за `trace_id`: груп 12, усі однакового розміру.
3. `POST /v1/auth/login` з `Authorization: Bearer <маркер-1>` і паролем `<маркер-2>`. Access-log цього запиту є, а маркерів у всьому stdout немає.

**`npm run demo:metrics`** — два скрейпи `/metrics` до і після:

1. Прогрів одним запитом, `series-before`.
2. 100 запитів зі ста різними id, `series-after`.
3. 10 запитів з `x-fault: 500` і 2 повільні запити.

`sent-ok` — усе, що не 5xx; сюди входять 404 на неіснуючі id. `counter-delta` і `errors-delta` — різниця сум `http_requests_total{route="/v1/orders/:id"}` між скрейпами. `above-top-bucket` — `_count − _bucket{le="10"}` того самого маршруту.

**`npm run demo:trace`** — `POST /v1/orders` з `traceparent`, `Idempotency-Key` і `x-fault: 500` → 500. Рядок access-log шукається **за `idempotencyKey`** з контексту, а не за `trace_id`, тож порівняння `trace-matches-log` не замкнене саме на себе. Після SIGTERM (SDK скидає батч) Jaeger опитується до 20 с.

- `orphan-spans` — це спани, чий батьківський спан не знайдено в трейсі й не дорівнює parent-id із заголовка. Батько серверного спана віддалений і в Jaeger не потрапляє, і це нормально.
- `span-status-error` — `otel.status_code=ERROR` у серверного спана.

Три прогони поспіль, вивід однаковий:

```text
# demo:logs ×3
non-json-lines=0 layers=4 distinct-trace-ids=1 trace-id-matches-header=1 burst=12 burst-trace-ids=12 burst-uneven=0 secret-req-logged=1 secret-in-logs=0
# demo:metrics ×3
sent-ok=103 sent-fail=10 counter-delta=113 errors-delta=10 above-top-bucket=0 series-before=4 series-after=4 prometheus-target-up=1
# demo:trace ×3
status=500 spans=45 orphan-spans=0 trace-matches-header=1 trace-matches-log=1 span-status-error=1
```

У трейсі 45 спанів: серверний HTTP, middleware/router Express, Redis (deny-list), а також SQL `pg` у транзакції checkout (`UPDATE products`, `UPDATE users`, `INSERT orders`, …, `ROLLBACK`).

Щоб переконатись, що демо ловлять поломку, я ламав зібраний `dist`:

| Поломка                                              | Що показало демо                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `route` = сирий шлях (`req.originalUrl`)             | `series-before=4 series-after=104`, `counter-delta=0`, exit=1         |
| прибрати `import './observability/otel'` з `main.ts` | `trace-id-matches-header=0`, `spans=0`, `trace-matches-log=0`, exit=1 |

### SLO (бонус)

- **SLI**: частка відповідей `/v1/orders*`, які не 5xx, тобто `1 − Errors`-панель.
- **SLO**: 99,5 % за 30 днів.
- **Error budget**: 0,005 × 30 діб × 24 год × 60 хв = **216 хвилин** повної недоступності на місяць, або 0,5 % запитів.

## AWS

смуга: основна
teardown-run: https://github.com/serhii-chernousov/marketplace-template/actions/runs/45659072423
регіон: eu-central-1
акаунт: акаунт AWS існував раніше — Free plan недоступний, плачу живими грошима з першої хвилини; захист — бюджет і нічний teardown.

Програми: `infra/base`, `infra/demo` (кожна — окремий npm-пакет зі своїм `package-lock.json`). Обовʼязкові npm-скрипти (`up:base`, `up:demo`, `destroy:demo`, `destroy:base`, `demo:failover`, `demo:nat`, `demo:alb`) лежать у кореневому `package.json`, а не в `infra/*/package.json`.

Курсовий уперше стоїть на чужому платному залізі. Питання тут не «чи підніметься», а «чи знесеться так, що від нього нічого не лишиться». Тому знесення — частина коду, а доказ — шість нулів у лозі GitHub Actions, а не мій термінал.

### Два стеки — два рахунки

| Стек   | Що всередині                                                                                   | Скільки коштує                                        | Скільки живе                                    |
| ------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| `base` | бюджет, VPC, 2 публічні + 2 приватні підмережі у двох AZ, IGW, route tables, 3 SG, OIDC + роль | $0/год                                                | тиждень і більше; після здачі — `destroy:base`  |
| `demo` | RDS PostgreSQL Multi-AZ, ALB + target group з Lambda, NAT за прапорцем `hw31:withNat`          | ≈ $0,082/год (див. таблицю), NAT ще +$0,057 за вправу | один вечір; щоночі о 02:00 UTC зносить teardown |

Бюджет — перший ресурс: VPC має `dependsOn` на нього, тож у порожньому акаунті нічого не зʼявиться раніше за алерт. Ліміт $5/міс, лист на `ACTUAL > 20 %`. Це лист, а не гальмо: оновлення раз на 8–12 годин, тобто стек встигне намотати до $0,98 до першого листа. Зупиняють тут Free plan (з картки не можна списати) і `destroy`.

Приватність перевіряється не назвою, а рядком маршруту: у приватних підмереж окрема route table без `0.0.0.0/0` (`private-default-route=0` у `evidence/base.txt`). NAT у `base` немає — у приватних підмережах живе тільки база, їй інтернет не потрібен.

### Погодинна ставка

TODO: звір кожен рядок із прайс-листом AWS сам і впиши дату, коли бачив сторінку. Числа нижче — зі знімка 24.08.2026, eu-central-1, місяць = 730 год.

| Рядок                                 | Ставка                      | За 730 год    | Дата прайс-листа |
| ------------------------------------- | --------------------------- | ------------- | ---------------- |
| ALB                                   | $0,02700/год                | $19,71        | TODO             |
| RDS db.t4g.micro PostgreSQL, Multi-AZ | $0,03700/год                | $27,01        | TODO             |
| gp3 20 ГіБ, Multi-AZ                  | $0,274/ГіБ-міс × 20         | $5,48         | TODO             |
| Public IPv4 × 2 (під ALB)             | $0,00500/год × 2            | $7,30         | TODO             |
| LCU — припущення, не ставка           | навчальне навантаження      | $0,29         | —                |
| Lambda-ціль                           | у межах безкоштовних квот   | ≈ $0          | TODO             |
| **Разом**                             |                             | **$59,79**    |                  |
| NAT Gateway + його IPv4 (лише вправа) | $0,052 + $0,005, 1 год мін. | $0,057 разово | TODO             |

Похідні з одного числа: $59,79 ÷ 730 = $0,08191/год · × 4 год = $0,33 · × 24 год = $1,97/добу · $200 кредитів ÷ $1,97 = 101 доба. Змінився хоч один рядок — перераховую всі похідні.

Три правила округлення: ALB і NAT білять партіальну годину як повну, RDS — посекундно з мінімумом 10 хвилин.

### Бекенд стану: чим відрізняється від #28

На #28 стан лежав у `file://.pulumi` з passphrase — це працює, поки все запускається з ноутбука. Тут знесення запускає воркер GitHub, який мого ноутбука не бачить, тому стан у Pulumi Cloud (individual, $0), secrets provider — `service`. Наслідки:

- `Pulumi.base.yaml` і `Pulumi.demo.yaml` закомічені: `encryptionsalt` у них немає, а регіон і `aws:defaultTags` мають бути в git, а не в `~/.aws/config`.
- Локально `pulumi login` не виконується: `scripts/pulumi-aws.sh` бере `PULUMI_ACCESS_TOKEN` і `PULUMI_ORG` зі сховища через `scripts/with-secrets.sh`, як і AWS-ключі оператора.
- У CI токен Pulumi не зберігається: `pulumi/auth-actions` обмінює OIDC-токен GitHub на короткоживучий токен Pulumi.

### Ключі: де їх немає

- Конвеєр: жодного довгоживучого ключа. `aws-actions/configure-aws-credentials` бере OIDC-токен GitHub (`id-token: write`) і обмінює його на STS-креденшели ролі `hw31-teardown`. Trust policy: `aud = sts.amazonaws.com`, `sub` звужений до `repo:serhii-chernousov@198785733/marketplace-template@1347460702:ref:refs/heads/{main,hw-31}` (`main` — для cron, `hw-31` — для dispatch-прогону). Формат із числовими ID власника і репозиторію — те, що GitHub реально кладе в токен (перший прогін упав з `AccessDenied`, справжній `sub` видно в CloudTrail-події `AssumeRoleWithWebIdentity`). ID не змінюються при перейменуванні, тож репозиторій, створений заново з тим самим імʼям, роль не отримає. ARN ролі і org Pulumi — repository variables, а не secrets: вони не секретні.
- Локально: ключі IAM-користувача оператора приїжджають зі сховища ДЗ #11 через ту саму обгортку `scripts/with-secrets.sh`. `aws configure` не виконувався.

### IAM: кожен дозвіл ролі teardown

Жодного `*` в `Action`. Describe/List-дії в IAM не мають resource-level дозволів, тому вони на `Resource: "*"`; усе, що видаляє, звужене до регіону й акаунта, а IAM — до префікса `hw31-demo-*`, щоб роль не могла видалити сама себе.

| Дія                                                                                                      | Навіщо                                                                 |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `tag:GetResources`                                                                                       | перевірка `tagged-resources-left`                                      |
| `rds:DescribeDBInstances`                                                                                | Pulumi чекає, поки інстанс зникне; перевірка `rds-left`                |
| `rds:DescribeDBSubnetGroups`                                                                             | Pulumi читає subnet group перед видаленням                             |
| `rds:DeleteDBInstance`                                                                                   | знести RDS                                                             |
| `rds:DeleteDBSubnetGroup`                                                                                | знести DB subnet group                                                 |
| `elasticloadbalancing:DescribeLoadBalancers`                                                             | Pulumi чекає видалення ALB; перевірка `alb-left`                       |
| `elasticloadbalancing:DescribeListeners`, `DescribeTargetGroups`, `DescribeTargetHealth`, `DescribeTags` | Pulumi читає listener, target group і реєстрацію цілі перед видаленням |
| `elasticloadbalancing:DeleteListener`, `DeleteLoadBalancer`, `DeleteTargetGroup`                         | знести ALB, listener і target group                                    |
| `elasticloadbalancing:DeregisterTargets`                                                                 | відвʼязати Lambda від target group                                     |
| `lambda:GetFunction`, `lambda:GetPolicy`                                                                 | Pulumi читає функцію і її resource policy                              |
| `lambda:DeleteFunction`, `lambda:RemovePermission`                                                       | знести функцію і дозвіл ALB її викликати                               |
| `logs:DeleteLogGroup`                                                                                    | знести лог-групу функції (інакше лишиться хвіст поза стеком)           |
| `iam:GetRole`, `ListRolePolicies`, `ListAttachedRolePolicies`, `ListInstanceProfilesForRole`             | Pulumi перевіряє, що в ролі Lambda нічого не лишилось                  |
| `iam:DetachRolePolicy`, `DeleteRolePolicy`, `DeleteRole`                                                 | знести виконавчу роль Lambda (лише `role/hw31-demo-*`)                 |
| `ec2:DescribeNatGateways`, `ec2:DescribeAddresses`                                                       | Pulumi чекає видалення NAT/EIP; перевірки `nat-left`, `eip-left`       |
| `ec2:DeleteNatGateway`, `ec2:DisassociateAddress`, `ec2:ReleaseAddress`                                  | знести NAT і звільнити його Elastic IP                                 |
| `ec2:DescribeVpcs`, `DescribeSubnets`, `DescribeRouteTables`, `DescribeInternetGateways`                 | Pulumi читає мережу `base` перед видаленням (`scope=network`)          |
| `ec2:DescribeSecurityGroups`, `DescribeSecurityGroupRules`, `DescribeNetworkInterfaces`                  | Pulumi чекає, поки ENI балансувальника звільнять SG і підмережі        |
| `ec2:DeleteRoute`, `DisassociateRouteTable`, `DeleteRouteTable`                                          | знести маршрути і route tables                                         |
| `ec2:DetachInternetGateway`, `DeleteInternetGateway`                                                     | знести IGW                                                             |
| `ec2:RevokeSecurityGroupIngress`, `RevokeSecurityGroupEgress`, `DeleteSecurityGroup`                     | знести правила і SG                                                    |
| `ec2:DeleteSubnet`, `DeleteVpc`                                                                          | знести підмережі і VPC                                                 |

Негативний тест на рушії, який ухвалює рішення (AWS, а не мій код), — `npm run evidence:iam`, повний вивід у `evidence/iam-simulate.log.txt`:

```text
$ aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::383905875072:role/hw31-teardown --action-names rds:DescribeDBInstances
{
  "EvalActionName": "rds:DescribeDBInstances",
  "EvalResourceName": "*",
  "EvalDecision": "allowed"
}

$ aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::383905875072:role/hw31-teardown --action-names iam:CreateAccessKey
{
  "EvalActionName": "iam:CreateAccessKey",
  "EvalResourceName": "*",
  "EvalDecision": "implicitDeny"
}
```

Повний JSON обох прогонів (з `MatchedStatements`) — у `evidence/iam-simulate.log.txt`.

Зелений тест доводить, що роль щось уміє; заборону доводить тільки негативний. І це одна дія проти одного принципала, а не «акаунт безпечний».

### Знесення

`.github/workflows/teardown.yml`: `schedule` о 02:00 UTC (зносить `demo`, коли я про нього забув) і `workflow_dispatch` (зносить зараз — цей прогін і здається). Порядок у джобі: `pulumi destroy` → `pulumi stack export | jq` → шість перевірок у `eu-central-1` і `us-east-1` → шість рядків контракту.

Чому в dispatch є `scope=network`. Обидва стеки мають тег `Project=nodejs-pro-hw31`, тож поки живе VPC з `base`, `tagged-resources-left` чесно не дорівнює нулю. Знести `base` повністю з тієї ж джоби не можна: разом із ним зникне OIDC-роль, під якою джоба працює, і перевірки отримають AccessDenied. Тому здавальний прогін зносить `demo` і всю мережу `base` (`--target` по `aws:ec2/**` і `aws:vpc/**`), а лишає тільки запобіжники, які коштують $0: бюджет, OIDC-провайдер і роль. `state-resources-left` рахується по стеку `demo`. Після перевірки ДЗ `npm run destroy:base` зносить і їх — роль із правом знесення не має жити довше за курс.

Заміряно після `up:base` (25.11.2026): `resourcegroupstaggingapi` у `us-east-1` бачить OIDC-провайдер і бюджет (IAM-роль — ні), тобто запобіжники рахувалися б як хвіст. Тому на них трьох тег `Project` перевизначено на `nodejs-pro-hw31-guard` (`infra/base/guard.ts`), а `Stack` і `ManagedBy` лишаються. Після цього `tagged-resources-us-east-1=0`, а в `eu-central-1` по тегу видно всю мережу `base` (`tagged-resources` у `evidence/base.txt`).

Ще один хвіст, якого немає ні в стані Pulumi, ні в AWS: перший `CreateSubnet` для `public-1` упав з `RequestLimitExceeded` (видно в CloudTrail), провайдер повторив запит, а індекс тегів запамʼятав ID невдалої спроби (`subnet-0c432a…`). Такої підмережі не існувало (`InvalidSubnetID.NotFound`), але `get-resources` рахував її ще годину. Знято `untag-resources` по її ARN — саме тому контракт знесення питає і стан, і індекс тегів: розходження двох джерел правди і є хвіст.

Те саме повторилось у першому прогоні `scope=network` (run 45647829244): `destroy` зніс усе, пʼять лічильників — 0, але `tagged-resources-left=6`. Це пʼять правил SG, видалених разом зі своїми SG, і NAT із вправи, видалений за годину до того. Жодного з шести в AWS не існувало (`InvalidSecurityGroupRuleId.NotFound`, `NatGatewayNotFound`), а індекс тримав їх і через 20 хвилин — довше, ніж джоба чекає. Після перевірки кожного ARN на відсутність теги знято `untag-resources`, і здавальний прогін — повторний: `destroy` у ньому вже нічого не знаходить, а перевірки рахують чесні нулі.

### Заміри

Живий прогін 25.11.2026, `evidence/demos.txt`. `up:demo` — 15 хв, з них RDS Multi-AZ — 14 хв 49 с.

- Failover: AZ `eu-central-1a` → `eu-central-1b` за 44 с (між подіями RDS «failover started» і «failover completed»; від виклику до `available` — 70 с), подія: «Multi-AZ instance failover completed». `--force-failover` — керований перемикач: я міряю процедуру, а не інцидент. Сам failover рядка в рахунку не додає: standby уже оплачений у ціні Multi-AZ.
- 44 с — менше за офіційні «typically 60–120 seconds»: на порожній базі без навантаження standby нічого доганяти.
- Перша спроба (за кілька хвилин до цієї) дала подію «Multi-AZ instance failover completed» за 48 с, але `AvailabilityZone` у `describe-db-instances` лишилась `eu-central-1a` і не змінилась за 6 хвилин спостереження. Подія сама по собі не доводить перемикання — тому критерій читає AZ, а не текст події. Друга спроба перемкнула AZ, у `evidence/demos.txt` — вона.
- ALB: `http-code=200`, `target-state=healthy` (ціль — Lambda, health check `/health`). `target-state` головніший за код: нездорова ціль дає 503.
- NAT: жив 3 хв, сплачено 1 год. «Each partial NAT Gateway-hour consumed is billed as a full hour.» Вправа — $0,057, той самий NAT у проді — ≈ $41/міс за кожну AZ разом з його IPv4.

### RDS Multi-AZ проти мого стека з #15

Мій стек #15 — це один `postgres:16-alpine` + PgBouncer (`pool_mode = transaction`) + `scripts/backup.sh` (`pg_dump -Fc` за cron о 03:00) + `scripts/restore-drill.sh` (RTO 2 с, RPO 24 год у `RESTORE-DRILL.md`). Репліки в ньому не було.

RDS Multi-AZ забирає на себе:

- синхронний standby в іншій AZ і автоматичний failover на нього — те, чого в #15 не було взагалі;
- автоматичні бекапи з point-in-time recovery замість cron + `pg_dump`: RPO падає з 24 годин до хвилин, хоча retention тут 1 день, а не тиждень;
- шифрування диска (`aws/rds`), патчі minor-версій у вікні обслуговування, заміну заліза.

Лишає мені:

- пул зʼєднань: PgBouncer нікуди не дівається (RDS Proxy — окремий платний рядок);
- міграції і сам `restore-drill.sh`: бекап, який ніхто не відновлював, не рахується, а RDS не відновлює його за мене в тестову базу;
- читання з репліки: standby Multi-AZ instance читати не можна, read replica — окремий ресурс і окремий рядок рахунку;
- ліміти зʼєднань і памʼять `db.t4g.micro`, розмір пулу і таймаути застосунку.

### KMS

`storageEncrypted: true` шифрує диск ключем `aws/rds` — AWS-managed, $0. KMS — не заміна сховищу секретів з #11, а шар під ним: envelope encryption, де KMS-ключ шифрує ключ даних (той самий `ENCRYPTION_KEY`), а сам ключ даних живе в Infisical. Власний customer-managed key я не створював: це $1/міс, і після `destroy` він не зникає того ж дня, а висить у pending deletion 7–30 днів — рядок рахунку, який переживає знесення.

### Відомі обмеження

- Ціль ALB — Lambda поза VPC, а не мій образ: критерій читає код відповіді і стан цілі, а EC2 додав би ще один погодинний рядок і ще одну Public IPv4.
- Файли в `evidence/` пише моя машина — вони підробляються. Гейт — тільки прогін CI.
- Цим ДЗ я не навчився масштабу (один `db.t4g.micro`, нуль трафіку) і FinOps — тільки не забувати зносити.

## Grading

### ДЗ #29 — Observability

```bash
docker compose up -d --wait   # курсовий + стенд спостережуваності (observability/compose.yaml через include)

export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:22918   # Jaeger, OTLP/HTTP
export PROMETHEUS_URL=http://127.0.0.1:22901
export TRACE_API_URL=http://127.0.0.1:22904                  # Jaeger query API (/api/traces/<id>)
export SKIP_VAULT=1       # у грейдера немає доступу до сховища

export DB_HOST=127.0.0.1 DB_PORT=6432 DB_USER=admin DB_PASSWORD=admin-secret DB_NAME=shop
export DB_URL=postgres://admin:admin-secret@127.0.0.1:6432/shop
export PORT=3000
export BROKER_URL=amqp://app:app@127.0.0.1:5672
export REDIS_URL=redis://127.0.0.1:16379
export REDIS_QUEUE_URL=redis://127.0.0.1:16380
export STORAGE_ENDPOINT=http://127.0.0.1:19000 STORAGE_REGION=us-east-1
export STORAGE_ACCESS_KEY=hw26user STORAGE_SECRET_KEY=hw26secretpass STORAGE_BUCKET=hw26-files
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

npm ci
npx tsc --noEmit; echo "exit=$?"
npm run build
npm run migrate
npm run seed

npm run demo:logs
npm run demo:metrics
npm run demo:trace
```

Демо самі піднімають застосунок (`node dist/main.js`) на портах 3411–3413, окремо його запускати не треба. Дашборд: <http://127.0.0.1:22900> (`admin` / `admin`), трейси: <http://127.0.0.1:22904>. Щоб дашборд ожив поза демо, запусти `npm start` (порт 3000) і дай трохи трафіку.

### ДЗ #28 — Kubernetes

Потрібно: Docker (≥ 4 ГіБ памʼяті), kind, pulumi ≥ 3, kubectl, Node 22.

```bash
export SKIP_VAULT=1                              # у грейдера немає доступу до сховища
export PULUMI_BACKEND_URL="file://$PWD/.pulumi"
export PULUMI_CONFIG_PASSPHRASE=hw28-grading
export DB_PASSWORD=grader-db-hw28
export REDIS_PASSWORD=grader-redis-hw28
export BROKER_PASSWORD=grader-amqp-hw28
export STORAGE_ACCESS_KEY=grader-minio-hw28
export STORAGE_SECRET_KEY=grader-minio-secret-hw28   # MinIO вимагає ≥ 8 символів

# одноразова пара ES256 і перець, як у ДЗ #26
node -e 'const {generateKeyPairSync}=require("node:crypto");
const k=generateKeyPairSync("ec",{namedCurve:"P-256",
  privateKeyEncoding:{type:"pkcs8",format:"pem"},
  publicKeyEncoding:{type:"spki",format:"pem"}});
const fs=require("node:fs");
fs.writeFileSync("/tmp/priv.b64",Buffer.from(k.privateKey).toString("base64"));
fs.writeFileSync("/tmp/pub.b64",Buffer.from(k.publicKey).toString("base64"));'
export JWT_KID=grader-hw28-kid
export JWT_PRIVATE_KEY="$(cat /tmp/priv.b64)"
export JWT_PUBLIC_KEY="$(cat /tmp/pub.b64)"
export REFRESH_TOKEN_PEPPER="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"

npm --prefix infra ci
printf 'dummy-npm-token' > .npm_token   # секрет етапу збірки; у git його немає

npm run image:build                      # docker/Dockerfile -> marketplace-api:<git sha>
npm run cluster:up                       # kind create + kind load (застосунок і образи залежностей)
npm run up                               # pulumi: platform -> secret -> migrate Job -> api -> worker -> smoke

npm run demo:image
SCAN_MAX=-1 npm run scan; echo "exit(max=-1)=$?"
SCAN_MAX=99999 npm run scan; echo "exit(max=99999)=$?"
npm run demo:rollout
PROFILE=broken npm run demo:rollout      # контраст; після заміру кластер повертається в correct
npm run demo:pdb
npm run demo:platform-blip               # перезапуск Redis під навантаженням

npm run destroy && npm run cluster:down
```

Імена для перевірок: namespace `marketplace`, deploy / pdb / hpa `marketplace-api`. Перший `npm run up` (з порожнім кластером) займає ~40 с, наступні — ~15 с.

### Попередні ДЗ

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
npm run test:unit          # бізнес-логіка без HTTP і БД: переходи статусу, ефект споживача, auth, кеш
npm run test:integration   # Product / Order / CheckoutService / OrderRepository проти Postgres
npm run test:e2e           # контур на Postgres + RabbitMQ: pending → paid, replay, 409/403; POST → GET + 404
npm run test:contract      # consumer → генерує pacts/*.json
npm run verify:provider    # справжній Nest проти контракту
```

Каталог `pacts/` створює `test:contract` (і CI теж). Він у `.gitignore` — у git не комітимо згенеровані файли.

Happy path E2E: `POST /v1/orders` пише замовлення через `CheckoutService`, а `GET /v1/orders/:id` читає його з Postgres (`orders` + `order_items`). Невідомий id відповідає 404.

Контурний E2E (`test/e2e/order-contour.e2e.spec.ts`) піднімає ще й RabbitMQ у Testcontainers і вмикає `MESSAGING_ENABLED=1`: замовлення створюється `pending`, relay і споживач у тому ж процесі переводять його в `paid`, у БД рівно один опублікований рядок outbox і один ефект. Інші сьюти працюють з `MESSAGING_ENABLED=0`.

CI (`.github/workflows/ci.yml`): `nest build` (tsc) → prettier → redocly lint → `check:env` → unit; integration двічі поспіль; e2e; actionlint. Actions запінені за SHA.

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
