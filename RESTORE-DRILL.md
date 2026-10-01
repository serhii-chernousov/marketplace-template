# Restore drill

- Дата прогона: 2026-10-01
- Дамп: backups/shop-2026-10-01T10-54-57.dump
- Размер дампа: 22385 bytes
- Время восстановления: 2 seconds (от `docker volume create` / `docker run` через `pg_isready` до конца `pg_restore`)
- RTO: 2 seconds (стенное время полного restore-drill: старт одноразового контейнера + `pg_isready` + `pg_restore`)
- RPO: 24 hours (`backup.cron` в 03:00 раз в сутки; сбой перед следующим запуском теряет до 24 часов записей)
- Контрольная сумма: `before=6|50290` / `after=6|50290` → MATCH (два прогона подряд; при `count(*)=0` скрипт падает)
