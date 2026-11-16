# Antigravity Workstation

![Windows 10/11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?style=flat-square)
![Antigravity IDE 2.7.0 · 2.6.0](https://img.shields.io/badge/Antigravity%20IDE-2.7.0%20%7C%202.6.0-4285F4?style=flat-square)
![x64 · ARM64](https://img.shields.io/badge/CPU-x64%20%7C%20ARM64-555?style=flat-square)

Готовый профиль **Antigravity IDE 2.7.0 и 2.6.0** для Windows одной командой: настройки редактора, расширения, темы и шрифты Aster Atelier, панели GitHub и npm, правила и агент, который работает без лишних вопросов. AI-подсказки выключены, обычный IntelliSense остаётся. Перед изменениями создаётся резервная копия.

Версия **3.11.1**. Что нового — в конце страницы.

Репозиторий: https://github.com/safarovmurod/antigravity-workstation · [Скачать ZIP](https://github.com/safarovmurod/antigravity-workstation/archive/refs/heads/main.zip)

<a id="quick-start"></a>

## Шаг 0 — твоё имя для GitHub

Один раз на компьютере, в Git Bash или PowerShell. Почта — та, что привязана к GitHub, или адрес `…@users.noreply.github.com` со страницы [github.com/settings/emails](https://github.com/settings/emails):

```bash
git config --global user.name "Имя Фамилия"
```

```bash
git config --global user.email "почта@пример.com"
```

Панель **GitHub** сама подписывает commits в каждом проекте именем владельца репозитория; этот шаг нужен для терминала и как запасной вариант.

## Установка — 3 шага

1. **Antigravity IDE 2.7.0** (или уже установленная 2.6.0) с [официального сайта](https://antigravity.google/download): 2.7.0 — [x64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.7.0-4507555968450560/windows-x64/Antigravity%20IDE.exe) · [ARM64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.7.0-4507555968450560/windows-arm64/Antigravity%20IDE.exe); 2.6.0 — [x64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.6.0-5526304964083712/windows-x64/Antigravity%20IDE.exe) · [ARM64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.6.0-5526304964083712/windows-arm64/Antigravity%20IDE.exe). Любой диск (C:, D:, E: …). Для команды 2 открой IDE один раз, войди в аккаунт и закрой все окна.
2. **Windows PowerShell** из меню **Пуск** (терминал внутри Antigravity не подходит).
3. Вставь **одну** команду ниже и нажми **Enter**. Окно не закрывай до зелёной рамки **DONE**.

| | Команда 1 — с нуля | Команда 2 — обновить |
| --- | --- | --- |
| Когда | Antigravity как на новом компьютере | Всё уже стоит, нужно обновить |
| Кэш и логи IDE | **Удаляются** (IDE создаст их заново) | Не трогаются |
| Настройки, клавиши, расширения, правила, skills, MCP | **Удаляются все**, ставится только профиль | Изменённое в `main` заменяется, старое удаляется; твои тема, шрифты и свои настройки остаются |
| Вход, чаты, память агента | Уходят в резервную копию — войди заново | Остаются |
| Резервная копия | `%USERPROFILE%\.gemini\backups\full-reset-<время>` | `%USERPROFILE%\.gemini\backups` |
| Папки проектов | Не трогаются | Не трогаются |

Команда 1 очищает все места Antigravity на любом диске: `%APPDATA%\Antigravity IDE` (и старое `Antigravity`), `%USERPROFILE%\.antigravity-ide`, `.antigravity`, `.antigravity-tools`, `%USERPROFILE%\.gemini` (кроме `backups`) и портативную папку `data`. Твои данные не удаляются — они переносятся в копию (список в её `manifest.json`); удаляются только кэш и логи. Вернуть старое: закрой Antigravity и перенеси папки из копии на их места.

## 1. Полный сброс и установка с нуля

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

## 2. Установить или обновить

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

## Что происходит в окне

Шаги с полосой прогресса: **Windows и IDE → Node.js и Git** (ставятся сами через winget) **→ загрузка `main` → (команда 1: сброс) → установка → Doctor**. При сбросе Antigravity сама один раз откроется и закроется — ничего не нажимай. Конец — зелёная рамка **DONE** и `Doctor: 0 failures`. Открой Antigravity (после команды 1 войди в аккаунт): профиль применяется при первом запуске. Через минуту перезапусти IDE — включится плавный Jelly Cursor.

## Что получишь

| Функция | Как работает |
| --- | --- |
| AI-подсказки | Ghost text, AI Tab и next edit **выключены**. IntelliSense остаётся: `cons` → `console`, методы, автоимпорт |
| Сохранение | Автосохранение через **1 с**; **Ctrl+S**, **Shift+Alt+F** или **Ctrl+Alt+F** — Prettier: отступ **2** пробела, без `;`, двойные кавычки. Пробелы в конце строк убираются, в конце файла — одна пустая строка |
| Поиск | **Ctrl+Shift+F** — поиск по всем файлам проекта |
| Подсказки | **Ctrl+Space** / **Alt+Space**; **Enter** принимает подсказку только когда это уместно (`smart`) |
| Скобки, кавычки, теги | `(` → `()`, `"` → `""`, и в JSX; переименование открывающего тега меняет закрывающий (встроенный linked editing) |
| Ошибки | Видны, но не режут глаз: ошибки ~70%, предупреждения ~55%, info ~45%, hint ~35%; подчёркивания одного тона в тёмных и светлых темах. **Pretty TypeScript Errors** показывает ошибки TS понятным текстом |
| Чужие символы | Русская `с` или `а` внутри имени в коде (`сount`) и невидимые символы из чатов подсвечиваются; русский текст в комментариях и строках — нет |
| Explorer | Связанные файлы свёрнуты под главным: `package-lock.json` под `package.json`, `tsconfig.*.json` под `tsconfig.json`, `.env.*` под `.env` |
| Темы | **Ctrl+Shift+P → Aster Atelier: Темы и шрифты**. Два раздела, внутри — от тёмной к светлой. **Тёмные:** GitHub Dark, Tokyo Night, Catppuccin Mocha, Ayu Mirage, Dracula, One Dark Pro (по умолчанию), Nord + Dark+, Antigravity Dark, Solarized Dark. **Светлые:** Catppuccin Latte, One Light, Light Owl, GitHub Light + Light+, Antigravity Light. Клик — тема сразу. Ползунки яркости и контраста кода сразу показывают кусок кода в новых цветах |
| Шрифты | 10 шрифтов внутри расширения, работают офлайн: JetBrains Mono, Fira Code, Cascadia Code, Victor Mono, Monaspace Krypton Var, Iosevka, IBM Plex Mono (без лигатур), Geist Mono, Rec Mono Linear, Maple Mono. Толщина — кнопками **−** и **+**; начертание (курсив, курсивные комментарии, жирные ключевые слова…) толщину не меняет |
| Панель GitHub | **Explorer → GitHub**: создать репозиторий, подключить к GitHub (новый или существующий), галочки у файлов, Commit, Push, Pull, ветки. Команды выполняются в терминале **GitHub** (Git Bash) — видно каждую. Автор — владелец репозитория |
| Панель npm | **Explorer → npm-скрипты** под GitHub: `dev`, `build`, `lint`… Клик — скрипт запускается в своём терминале Git Bash, адрес `http://localhost:…` появляется рядом с кнопкой «Открыть в браузере» |
| Агент | Работает без вопросов: терминал и планы — Always Proceed, все команды разрешены, MCP — Allow. Терминал агента — Git Bash; спрашивает только перед необратимым (`git push --force`, `git reset --hard`, удаление твоих файлов). Отвечает на языке твоего сообщения |
| Расширения | Prettier, ESLint, Oxc, Error Lens, Pretty TypeScript Errors, Tailwind CSS, React-сниппеты, Live Preview, Vitest, Path/npm Intellisense, Import Cost, Material Icons и свои: Aster Atelier, Calm TypeScript, Git Branch Panel, Workstation Stability, Jelly Cursor |

## Если команда остановилась

| Надпись | Что сделать |
| --- | --- |
| `PAUSED: Antigravity is still running` | Окно покажет процессы (имя, PID, путь) и спросит **`Закрыть? (Y/N)`**. **Y** — закроет их и продолжит. **N** — закрой все окна Antigravity сам и вставь ту же команду |
| `PAUSED: this is the terminal of an editor` | Открой **Windows PowerShell** из меню Пуск и вставь команду там |
| `STOPPED: this setup supports only Antigravity IDE 2.7.0 or 2.6.0` | Установи 2.7.0 по ссылке выше и повтори |
| `STOPPED: Antigravity has never been started` | Только команда 2: открой IDE, войди в аккаунт, закрой окна и повтори |
| `Full reset stopped at … A program still uses it` | Закрой программу (Gemini CLI, `agy.exe`) или перезагрузи Windows и повтори. Ничего не удалено |
| `Setup conflict: edited …` | Ты менял файл профиля. Перенеси его в другую папку и повтори команду 2 |
| `[SETUP FAILED]` | Текст ошибки уже в буфере — вставь его в чат Antigravity. Подробнее: [проблемы и решения](docs/TROUBLESHOOTING.md) |

IDE в своей папке и не найдена? Перед командой вставь `$env:ANTIGRAVITY_INSTALL_DIR = 'D:\Папка, где лежит Antigravity IDE.exe'`.

## Установка через ИИ-агента

| Промпт | Для чего |
| --- | --- |
| [Windows](docs/prompts/WINDOWS-AI-SETUP.md) ([скачать](https://raw.githubusercontent.com/safarovmurod/antigravity-workstation/main/docs/prompts/WINDOWS-AI-SETUP.md)) | Любой ИИ-агент с терминалом (Claude Code, Codex, Gemini CLI, Cursor…) ставит профиль сам теми же командами 1 и 2 |
| [macOS](docs/prompts/MAC-AI-SETUP.md) ([скачать](https://raw.githubusercontent.com/safarovmurod/antigravity-workstation/main/docs/prompts/MAC-AI-SETUP.md)) | Mac: агент переносит тот же профиль скриптом проекта |

## Что нового в 3.11.1

- **Git Branch Panel 1.8.1:** если Git Bash прерывает команду (`exit code 130` — Ctrl+C, например пока терминал ещё запускается), панель сама выполняет её ещё раз в фоне, без ошибки.

## Что нового в 3.11.0

- **Aster Atelier 1.8.0:** 11 тем в двух разделах (тёмные / светлые) по яркости, тема меняется быстрее, живой предпросмотр цветов кода; 10 шрифтов (новые: Iosevka, IBM Plex Mono, Geist Mono, Rec Mono Linear, Maple Mono); толщина отдельно кнопками − / +.
- **Git Branch Panel 1.8.0:** новая панель **npm-скрипты**; команды git видны в терминале Git Bash; кнопки «Создать репозиторий», «Подключить к GitHub», Pull.
- **Профиль:** Ctrl+Shift+F снова ищет по файлам; отступ 2; ошибки заметнее; подсветка русских букв в коде; вложенные файлы в Explorer; linked editing вместо Auto Rename Tag; новые расширения Pretty TypeScript Errors, ESLint, Live Preview, Vitest.
- **Агент:** больше не спрашивает разрешения на обычные команды; правила для Git Bash (пути `/d/react`, `--yes` для CLI); ответ на языке сообщения.
- **Установка:** команда 1 удаляет кэш и логи; `PAUSED` показывает процесс и предлагает закрыть его; убран второй комплект JetBrains Mono (−4,4 МБ). Calm TypeScript 3.4.0 и Workstation Stability 1.3.29 — исправления.

[Все настройки](docs/SETTINGS-GUIDE.md) · [Расширения](docs/EXTENSIONS.md) · [Как вернуть AI-подсказки](docs/AI-COMPLETION.md) · [Совместимость ПК](docs/HARDWARE-COMPATIBILITY.md) · [Восстановление через чат](docs/CHAT-REPAIR.md)
