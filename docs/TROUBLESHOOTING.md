# Если установка завершилась с ошибкой

Читай первую ошибку этапа над итоговым сообщением. После исправления причины повтори [команду из README](../README.md#quick-start).

| Сообщение или проблема | Действие |
|---|---|
| Download / timeout / HTTP | Проверь доступ к GitHub и Marketplace. Команда делает до 3 попыток; при ошибке ZIP использует Git для того же commit. |
| Node / npm / Git / winget unavailable | Установи Node.js 24+, npm 10+ и Git, затем открой новый терминал. |
| Antigravity IDE was not found | Установи Antigravity IDE 2.8.0 (или 2.7.0 / 2.6.0) и открой её один раз. Для своей папки укажи её в `ANTIGRAVITY_INSTALL_DIR`. |
| supports only Antigravity IDE 2.8.0 or 2.7.0 or 2.6.0 / Unaudited build | Установи официальную IDE 2.8.0, 2.7.0 или 2.6.0 (ссылки в README). Не отключай проверку hash и не подменяй номер версии. |
| Open Antigravity once | Открой IDE один раз для создания профиля, затем повтори установку. |
| PAUSED: Antigravity is still running | Над надписью перечислены мешающие процессы этого сеанса Windows: имя, PID и путь (у Electron бывают фоновые процессы без окна). На вопрос `Закрыть? (Y/N)` ответь **Y** — установка закроет их сама (сначала обычным способом, через 15 с принудительно) и продолжит; **N** — закрой их сам и повтори команду. Без окна для ответа (скрипт, CI, ИИ-агент) вопроса нет, установка просто останавливается. Antigravity других пользователей Windows не мешает. |
| PAUSED: this is the terminal of an editor | Запусти команду из Windows PowerShell (меню Пуск), не из терминала IDE. |
| window did not close by itself and was stopped (жёлтая строка команды 1) | Это не ошибка, установка продолжается. Открой Antigravity, войди и закрой её обычным способом: при этом закрытии применятся разрешения агента. |
| Setup conflict / needs-attention | Сравни указанный файл с backup; проверь настройки проекта. |
| Extension registration failed | Проверь доступ к Marketplace и сообщение установки конкретного расширения. |
| Нет автоимпорта | Установи библиотеку в проект, проверь её exports/типы, нажми Ctrl+Space. Перезапусти TypeScript server через палитру команд. |
| Форматирование отличается | Проверь `.prettierrc`, `prettier.config.*` и `.editorconfig` своего проекта. |
| GitHub push не работает | Проверь `origin`, авторизацию Git и права на репозиторий. Вход в аккаунт IDE не всегда авторизует Git. |
| MCP не подключается | Проверь настройки, доступность и авторизацию конкретного сервиса; выбери Reconnect MCP. |
| `command 'antigravity.inlineDiff.undo' not found` | Возникает в Antigravity 2.7.0/2.8.0 после переключения на Side-by-Side (`antigravity.enableInlineDiff: false`), когда IDE удаляет команду, но не сбрасывает контекст `antigravity.inlineDiffCanUndo`. Обнови профиль командой 2 (`Workstation Stability` 1.3.30+ и резервные `ctrl+z`/`ctrl+y` в `keybindings.json` автоматически возвращают обычный Undo/Redo). |
| PostgreSQL `28P01` и текст ошибки `` | Это две отдельные причины: (1) `28P01` — неверный пароль/параметры подключения (например `DATABASE_URL` в `.env` проекта, спецсимволы без URL-кодирования); не ослабляй `scram-sha-256` в `pg_hba.conf` и не печатай пароли. (2) Символы `` — сервер PostgreSQL в Windows отправляет ошибки в CP1251 (`lc_messages = 'Russian_Russia.1251'` в `postgresql.conf`), а `node-postgres` (`pg`) читает их как UTF-8; задай `lc_messages = 'C'` в `postgresql.conf` и перезапусти службу `postgresql-x64-18`. |
| PowerShell `ParserError` на пути `"/c/..."` | Путь `/c/...` работает только в Git Bash. В Windows PowerShell (`PS ...>`) используй оператор `&` и Windows-путь: `& 'C:\Program Files\PostgreSQL\18\bin\createdb.exe' --version`; в Git Bash — `"/c/Program Files/PostgreSQL/18/bin/createdb.exe" --version`. |

Backup: `%USERPROFILE%\.gemini\backups`. Личные токены, базы и аккаунты не переносить между компьютерами.
