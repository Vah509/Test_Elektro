# site-check — диагностика производительности elektroschit.com.ua

Автоматический тестировщик: аудит структуры сайта + PageSpeed Insights + локальный Lighthouse + серверная диагностика.
Главная цель — не просто оценка, а **причины** плохой производительности («Топ причин» в начале каждого отчёта).

**Как пользоваться (коротко):**
1. Claude готовит ZIP с заданием (`jobs/*.json`, при необходимости `targets/*.txt`).
2. Вы кладёте ZIP в папку `inbox/` этого репозитория (GitHub → Add file → Upload files).
3. Тест запускается сам. Результат: файл в `reports/` и сообщение + отчёт в Telegram.

Репозиторий отдельный от сайта: коммиты с отчётами не запускают деплой Cloudflare.

## Документация
| Файл | О чём |
|---|---|
| [docs/setup.md](docs/setup.md) | Первая настройка: репозиторий, секреты, проверка |
| [docs/how-it-works.md](docs/how-it-works.md) | Устройство: поток, очередь, защита, модули, ограничения |
| [docs/job-format.md](docs/job-format.md) | Формат файла-задания и режимы |
| [docs/reading-reports.md](docs/reading-reports.md) | Как читать отчёт и где какие причины искать |
| [docs/changelog.md](docs/changelog.md) | История изменений |

## Структура
```
.github/workflows/site-check.yml   запуск по ZIP в inbox/ или вручную
scripts/site-check.mjs             сам тестировщик (аудит, PSI, lab, сервер, отчёт)
scripts/process-jobs.mjs           очередь: ZIP -> задания -> тест -> Telegram -> удаление ZIP
scripts/lib/telegram.mjs           отправка в Telegram
inbox/    сюда кладётся ZIP (после обработки архив удаляется)
jobs/     сохранённые задания (можно повторить вручную)
targets/  списки страниц для режима targets
reports/  отчёты: <дата_время UTC>_<режим>_<метка>.md/.json/.summary.txt
```
