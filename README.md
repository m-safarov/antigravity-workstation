# Antigravity Workstation

![Windows 10/11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?style=flat-square)
![Antigravity IDE 2.8.0 · 2.7.0 · 2.6.0](https://img.shields.io/badge/Antigravity%20IDE-2.8.0%20%7C%202.7.0%20%7C%202.6.0-4285F4?style=flat-square)
![x64 · ARM64](https://img.shields.io/badge/CPU-x64%20%7C%20ARM64-555?style=flat-square)

Готовый профиль **Antigravity IDE 2.8.0, 2.7.0 и 2.6.0** для Windows одной командой: настройки редактора, расширения, темы и шрифты Aster Atelier, панели GitHub и npm, правила и агент без лишних вопросов. AI-подсказки выключены, обычный IntelliSense и автоимпорт остаются и работают быстро. Перед изменениями всегда создаётся резервная копия.

Версия **3.13.0**. Репозиторий: https://github.com/safarovmurod/antigravity-workstation · [Скачать ZIP](https://github.com/safarovmurod/antigravity-workstation/archive/refs/heads/main.zip)

Требуется **Antigravity IDE 2.8.0** (или уже установленная **2.7.0** / **2.6.0**) с [официального сайта](https://antigravity.google/download):
- 2.8.0: [x64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.8.0-6733682917113856/windows-x64/Antigravity%20IDE.exe) · [ARM64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.8.0-6733682917113856/windows-arm64/Antigravity%20IDE.exe)
- 2.7.0: [x64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.7.0-4507555968450560/windows-x64/Antigravity%20IDE.exe) · [ARM64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.7.0-4507555968450560/windows-arm64/Antigravity%20IDE.exe)
- 2.6.0: [x64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.6.0-5526304964083712/windows-x64/Antigravity%20IDE.exe) · [ARM64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.6.0-5526304964083712/windows-arm64/Antigravity%20IDE.exe)

<a id="quick-start"></a>

## КОД 1 — чистая установка

Полный сброс и установка полного профиля с нуля (как на новом компьютере).

```powershell
& {
  $file = Join-Path $env:TEMP ('workstation-' + [guid]::NewGuid() + '.ps1')
  $url = 'https://raw.githubusercontent.com/safarovmurod/antigravity-workstation/main/scripts/bootstrap.ps1'
  try {
    curl.exe -fsSL --retry 3 --connect-timeout 20 --max-time 120 -o $file $url
    if ($LASTEXITCODE -or -not (Test-Path -LiteralPath $file)) {
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
      Invoke-WebRequest $url -OutFile $file -UseBasicParsing -ErrorAction Stop
    }
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File $file -CleanExtensions
  } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}
```

- **Где запускать:** обычный **Windows PowerShell** из меню **Пуск** (терминал внутри Antigravity не подходит). Закрой все окна Antigravity IDE (или ответь `Y` на запрос закрытия).
- **Что меняет:** если профиль уже есть, выводит явное предупреждение о полном сбросе, переносит все старые папки IDE (`%APPDATA%\Antigravity IDE` / `Antigravity`, `%USERPROFILE%\.antigravity-ide` / `.antigravity` / `.antigravity-tools`, `%USERPROFILE%\.gemini` кроме `backups`, портативную `data`) в одну резервную копию, удаляет из неё только пересоздаваемые кэши и логи (`manifest.json` → `deletedCaches`), один раз запускает и закрывает IDE для создания чистого профиля, проверяет целостность исходников/VSIX/шрифтов, ставит полный профиль и запускает `Doctor`.
- **Какие данные сохраняются:** папки проектов и старые копии в `%USERPROFILE%\.gemini\backups` не трогаются; прежние настройки, вход, чаты, расширения и история файлов лежат в резервной копии (после сброса в IDE нужно войти в аккаунт заново).
- **Где искать копию:** `%USERPROFILE%\.gemini\backups\full-reset-<время>` (список перенесённых папок — в `manifest.json`; для возврата закрой IDE и верни папки на прежние места).
- **Как понять, что всё успешно:** зелёная рамка **`DONE  Full reset and setup complete. Doctor: 0 failures. AI suggestions are off.`** и путь к резервной копии. После этого открой Antigravity IDE и войди в аккаунт.

## КОД 2 — обновление

Обновление существующего профиля на месте (подходит и для первой установки без сброса, если IDE уже открывалась хотя бы один раз).

```powershell
& {
  $file = Join-Path $env:TEMP ('workstation-' + [guid]::NewGuid() + '.ps1')
  $url = 'https://raw.githubusercontent.com/safarovmurod/antigravity-workstation/main/scripts/bootstrap.ps1'
  try {
    curl.exe -fsSL --retry 3 --connect-timeout 20 --max-time 120 -o $file $url
    if ($LASTEXITCODE -or -not (Test-Path -LiteralPath $file)) {
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
      Invoke-WebRequest $url -OutFile $file -UseBasicParsing -ErrorAction Stop
    }
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File $file
  } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}
```

- **Где запускать:** обычный **Windows PowerShell** из меню **Пуск** (не терминал внутри IDE). Предварительно открой Antigravity IDE хотя бы один раз, войди в аккаунт и закрой все окна.
- **Что меняет:** проверяет совместимость IDE (2.8.0 / 2.7.0 / 2.6.0), скачивает актуальный `main`, проверяет целостность всех обязательных конфигов, шаблонов, шрифтов и VSIX-пакетов, создаёт резервную копию, заменяет изменённые управляемые файлы и расширения, удаляет только подтверждённо устаревшие управляемые компоненты (`RETIRED_EXTENSIONS` и устаревшие файлы профиля), архивирует старые папки расширений, проверяет полноту установки и запускает `Doctor`. После обновления остаётся **строго одна активная версия** каждого управляемого расширения; повторный запуск той же версии проходит без дубликатов и лишней переустановки. При сбое обязательного шага профиль автоматически откатывается из копии, а `DONE` не выводится.
- **Какие данные сохраняются:** личные тема, шрифты, размер/толщина шрифта, направляющие, вид Error Lens, настройки вне профиля, сторонние расширения, папки проектов, вход в аккаунт, чаты и память агента.
- **Где искать копию:** `%USERPROFILE%\.gemini\backups\setup-backup-pre-install-<время>` (старые версии заменённых файлов профиля — `setup-payload-*`, архив старых папок расширений — `extension-stale-*`, откат из PowerShell: `node bin/workstation-setup.js restore`).
- **Как понять, что всё успешно:** зелёная рамка **`DONE  Setup complete. Doctor: 0 failures. AI suggestions are off.`** и проверка **`Single active version per managed extension`** со статусом `✓`.

| | КОД 1 — чистая установка | КОД 2 — обновление |
| --- | --- | --- |
| Когда выбирать | Нужен чистый профиль с нуля | Профиль уже стоит, нужно обновиться |
| Кэш и логи IDE | **Удаляются** (IDE пересоздаст их сама) | Не трогаются |
| Настройки, клавиши, расширения, правила, skills, MCP | **Сбрасываются**, ставится только профиль | Обновляются из `main`; старые управляемые версии архивируются; личная тема, шрифты и свои настройки остаются |
| Вход, чаты, память агента | Переносятся в резервную копию — войди заново | Сохраняются на месте |
| Резервная копия | `%USERPROFILE%\.gemini\backups\full-reset-<время>` | `%USERPROFILE%\.gemini\backups\setup-backup-pre-install-<время>` |
| Папки проектов | Не трогаются | Не трогаются |

## Что происходит в окне

После выбора команды все штатные шаги выполняются автоматически с полосой прогресса: **Windows и IDE (2.8.0 / 2.7.0 / 2.6.0) → Node.js 24+ и Git** (ставятся сами через winget) **→ скачивание `main` → проверка целостности → резервная копия → (КОД 1: сброс и автоинициализация IDE) → установка/обновление → итоговый Doctor**. При первом запуске КОДА 1 Antigravity сама откроется и закроется — ничего не нажимай. После **`DONE`** открой Antigravity (после КОДА 1 войди в аккаунт); через минуту перезапусти IDE, чтобы применился плавный Jelly Cursor.

## Имя для GitHub (один раз на компьютере)

Выполни один раз в Git Bash или Windows PowerShell. Почта — та, что привязана к GitHub, или адрес `…@users.noreply.github.com` со страницы [github.com/settings/emails](https://github.com/settings/emails):

```bash
git config --global user.name "Имя Фамилия"
git config --global user.email "почта@пример.com"
```

Панель **GitHub** сама подписывает commits в каждом проекте именем владельца репозитория; эти две строки нужны для терминала и как запасной вариант.

## Что получишь

| Функция | Как работает |
| --- | --- |
| IntelliSense и автоимпорт | AI ghost text, AI Tab и next edit **выключены**, а обычный TypeScript/JavaScript IntelliSense (`cons` → `console`, автоимпорт констант, функций и библиотек) ускорен: включён нативный watcher `--canUseWatchEvents`, `includePackageJsonAutoImports: "auto"`, `oxc.lint.run: "onSave"` и оптимизированы фоновые циклы расширений |
| Отмена правок (`Ctrl+Z`) | Исправлена ошибка Antigravity 2.7.0/2.8.0 `command 'antigravity.inlineDiff.undo' not found` после переключения на Side-by-Side: резервные привязки в `keybindings.json` и guard в `Workstation Stability` возвращают обычный Undo/Redo, не ломая нативный inline-diff |
| Сохранение и формат | Автосохранение через **1 с**; **Ctrl+S**, **Shift+Alt+F** или **Ctrl+Alt+F** — Prettier: отступ **2** пробела, без `;`, двойные кавычки. Пробелы в конце строк убираются, в конце файла — одна пустая строка |
| Поиск и подсказки | **Ctrl+Shift+F** — поиск по файлам; **Ctrl+Space** / **Alt+Space** — подсказки; **Enter** принимает подсказку только когда уместно (`smart`), **Tab** принимает выбранную подсказку или сниппет |
| Скобки, кавычки, теги | `(` → `()`, `"` → `""`, в JSX тоже; встроенный `editor.linkedEditing` переименовывает парный тег |
| Ошибки и Unicode | Видимые, но мягкие диагностики (~70% error, ~55% warning), **Pretty TypeScript Errors**; кириллица внутри идентификаторов (`сount`) и невидимые символы подсвечиваются, русский текст в комментариях и строках — нет |
| Explorer | Связанные файлы свёрнуты под главным: `package-lock.json` под `package.json`, `tsconfig.*.json` под `tsconfig.json`, `.env.*` под `.env` |
| Темы и шрифты | **Ctrl+Shift+P → Aster Atelier: Темы и шрифты**. 11 палитр в двух разделах («Тёмные» и «Светлые») + темы IDE, живой предпросмотр яркости/контраста, 10 офлайн-шрифтов с лигатурами, толщина кнопками **− / +** и 7 начертаний |
| Панели GitHub и npm | **Explorer → GitHub** (создать репозиторий, подключить, Commit, Push, Pull, ветки — команды видны в терминале Git Bash) и **Explorer → npm-скрипты** (`dev`, `build`, `lint`… с кнопкой «Открыть в браузере») |
| Терминал и агент | Встроенный терминал IDE — **Git Bash**; агент различает PowerShell (`& 'C:\...\tool.exe'`) и Git Bash (`"/c/..."`), работает без лишних вопросов (Always Proceed, MCP Allow) и спрашивает только перед необратимым (`git push --force`, `git reset --hard`, удаление файлов) |
| Расширения | 20 расширений из Marketplace (`trackLatest`) + 5 проверенных локальных VSIX: Aster Atelier, Calm TypeScript, Git Branch Panel, Workstation Stability, Jelly Cursor |

## Если команда остановилась

| Надпись | Что сделать |
| --- | --- |
| `PAUSED: Antigravity is still running` | Окно покажет процессы (имя, PID, путь) и спросит **`Закрыть? (Y/N)`**. **Y** — закроет их и продолжит. **N** — закрой все окна Antigravity сам и повтори команду |
| `PAUSED: this is the terminal of an editor` | Открой **Windows PowerShell** из меню Пуск и вставь команду там |
| `STOPPED: this setup supports only Antigravity IDE 2.8.0 or 2.7.0 or 2.6.0` | Установи 2.8.0 по ссылке выше и повтори |
| `STOPPED: Antigravity has never been started` | Только КОД 2: открой IDE, войди в аккаунт, закрой окна и повтори |
| `Full reset stopped at … A program still uses it` | Закрой программу (Gemini CLI, `agy.exe`) или перезагрузи Windows и повтори. Ничего не удалено |
| `Setup conflict: edited …` | Ты менял управляемый файл профиля. Перенеси его в другую папку и повтори КОД 2 |
| `[SETUP FAILED]` | Профиль автоматически откатывается из копии; текст ошибки уже в буфере — вставь его в чат Antigravity. Подробнее: [проблемы и решения](docs/TROUBLESHOOTING.md) |

IDE стоит в нестандартной папке и не нашлась автоматически? Перед командой вставь `$env:ANTIGRAVITY_INSTALL_DIR = 'D:\Папка, где лежит Antigravity IDE.exe'`.

## Установка через ИИ-агента

| Промпт | Для чего |
| --- | --- |
| [Windows](docs/prompts/WINDOWS-AI-SETUP.md) ([скачать](https://raw.githubusercontent.com/safarovmurod/antigravity-workstation/main/docs/prompts/WINDOWS-AI-SETUP.md)) | Любой ИИ-агент с терминалом (Claude Code, Codex, Gemini CLI, Cursor…) ставит профиль сам теми же командами КОД 1 и КОД 2 |
| [macOS](docs/prompts/MAC-AI-SETUP.md) ([скачать](https://raw.githubusercontent.com/safarovmurod/antigravity-workstation/main/docs/prompts/MAC-AI-SETUP.md)) | Mac: агент переносит тот же профиль скриптом проекта |

## Что нового в 3.13.0

- **Поддержка Antigravity IDE 2.8.0** (build `2.8.0-6733682917113856`, x64 и ARM64) вместе с **2.7.0** и **2.6.0**. Все 284 настройки редактора (`config/settings.json`), темы Aster Atelier, шрифты, Calm TypeScript и Jelly Cursor полностью сохранены.
- **Ускорение IDE и расширений без удаления настроек:** оптимизированы `Workstation Stability 1.3.31` (фильтрация несвязанных событий конфигурации, кеширование профиля и DOM Jelly Cursor, адаптивный интервал `workbench-ui`, остановка холостого опроса `repair-chat`), `Calm TypeScript 3.4.1` (сброс только активной декорации вместо 7 на каждое нажатие клавиши, кеш настроек), и `Git Branch Panel 1.8.2` (пропуск повторного обновления при переключении вкладок в той же папке и меньше запусков `git`).
- **Удалены устаревшие компоненты, которые Antigravity 2.8.0 уже делает сам:** дублирующие skills/агент (`workstation-workflow`, `project-coding-rules`, `workstation-verifier.md`), расширение `mikestead.dotenv` (подсветка `.env` встроена в IDE) и setup-owned MCP `sequential-thinking` (встроенный Thinking в 2.8.0; личные MCP-серверы и `chrome-devtools-mcp` сохраняются).
- **Чистота кода:** устранены все предупреждения линтера (`oxlint`: 0 ошибок, 0 предупреждений).

## Что нового в 3.12.0

- **Ускорение TypeScript/JavaScript IntelliSense и автоимпорта:** устранён ~2-секундный фриз Extension Host в **Workstation Stability 1.3.30** (`profile.cjs` больше не сканирует 150 языков на каждом переключении вкладок и не пишет 600+ предупреждений в `exthost.log`), включён нативный watcher TypeScript (`--canUseWatchEvents`), переведены `typescript.preferences.includePackageJsonAutoImports: "auto"` и `oxc.lint.run: "onSave"` без потери полноты подсказок.
- **Исправлена ошибка `command 'antigravity.inlineDiff.undo' not found`:** добавлен runtime-guard в **Workstation Stability 1.3.30** и безопасные fallback-привязки `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` в `keybindings.json`.
- **Терминал и диагностика:** правила агента (`GEMINI.template.md`) и документация теперь чётко разделяют синтаксис PowerShell (`& 'C:\...'`) и Git Bash (`"/c/..."`), добавлена диагностика PostgreSQL `28P01` и CP1251-кодировки (`lc_messages`).
- **Надёжность КОДА 1 и КОДА 2:** расширена preflight-проверка целостности всех VSIX и шрифтов до любых изменений, добавлен автоматический откат профиля при сбое на середине установки, пост-проверка полноты применённых файлов/настроек и контроль **строго одной активной версии** для каждого управляемого расширения в `Doctor`. Удалён устаревший скрипт `scripts/migrate-aster-profile.cjs`.

## Что нового в 3.11.1

- **Git Branch Panel 1.8.1:** если Git Bash прерывает команду (`exit code 130` — Ctrl+C, например пока терминал ещё запускается), панель сама выполняет её ещё раз в фоне, без ошибки.

## Что нового в 3.11.0

- **Aster Atelier 1.8.0:** 11 тем в двух разделах (тёмные / светлые) по яркости, тема меняется быстрее, живой предпросмотр цветов кода; 10 шрифтов; толщина отдельно кнопками − / +.
- **Git Branch Panel 1.8.0:** новая панель **npm-скрипты**; команды git видны в терминале Git Bash; кнопки «Создать репозиторий», «Подключить к GitHub», Pull.
- **Профиль и установка:** `Ctrl+Shift+F` снова ищет по файлам; отступ 2; заметные диагностики; Unicode-подсветка; `explorer.fileNesting`; `editor.linkedEditing` вместо Auto Rename Tag; Pretty TypeScript Errors, ESLint, Live Preview, Vitest; КОД 1 удаляет кэш и логи; `PAUSED` предлагает закрыть IDE (`Y/N`).

[Все настройки](docs/SETTINGS-GUIDE.md) · [Расширения](docs/EXTENSIONS.md) · [Как вернуть AI-подсказки](docs/AI-COMPLETION.md) · [Совместимость ПК](docs/HARDWARE-COMPATIBILITY.md) · [Восстановление через чат](docs/CHAT-REPAIR.md)
