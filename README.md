# Marketplace API (hw-09)

# Ресурси

- `GET/POST /v1/listings`, `GET/PATCH /v1/listings/{id}`
- `GET/POST /v1/orders`, `GET /v1/orders/{id}`

Гроші — цілі копійки (`price_cents`, `total_cents`). Ідентифікація користувача — тимчасові заголовки `X-User-Id` і `X-User-Role` (`buyer` | `seller`).

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

Змінні описує Zod-схема `src/config/env.schema.ts`. Контракт для git — `.env.example`; реальний `.env` у `.gitignore` і не потрапляє в Docker-образ. Пароль БД **не** в env: лише файл `secrets/db_password`.

| Змінна       | Обов'язкова        | Опис                                          |
| ------------ | ------------------ | --------------------------------------------- |
| `PORT`       | так                | HTTP-порт                                     |
| `DB_HOST`    | так                | Хост Postgres (`localhost` для Nest на хості) |
| `DB_PORT`    | так                | Порт Postgres                                 |
| `DB_USER`    | так                | Роль застосунку (`app_user`)                  |
| `DB_NAME`    | так                | Ім'я бази (`shop`)                            |
| `LOG_LEVEL`  | ні (дефолт `info`) | `debug` \| `info` \| `warn` \| `error`        |
| `TIMEOUT_MS` | ні (дефолт `5000`) | Таймаут у мс                                  |

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
