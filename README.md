# Antigravity Workstation

![Windows 10/11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?style=flat-square)
![Antigravity IDE 2.9.0 · 2.8.0 · 2.7.0 · 2.6.0+](https://img.shields.io/badge/Antigravity%20IDE-2.9.0%20%7C%202.8.0%20%7C%202.7.0%20%7C%202.6.0%2B-4285F4?style=flat-square)
![Next.js · Node.js · React · TS](https://img.shields.io/badge/Stack-Next.js%20%7C%20Node.js%20%7C%20React%20%7C%20TS-10B981?style=flat-square)
![x64 · ARM64](https://img.shields.io/badge/CPU-x64%20%7C%20ARM64-555?style=flat-square)

Готовый профессиональный профиль **Antigravity IDE** для разработки на **Next.js, Node.js, React, TypeScript и Tailwind CSS** на Windows одной командой: чистые настройки редактора, проверенные расширения, темы и шрифты **Aster Atelier**, командная панель **GitHub** (Pull, Push, PR, ветки, Tab-подсказка commit), панель **npm-скриптов**, правила агента без лишних вопросов и встроенный `Doctor`. AI-подсказки в коде выключены, обычный IntelliSense и автоимпорт работают быстро. Перед любыми изменениями создаётся резервная копия.

Версия **3.15.4**. Репозиторий: https://github.com/m-safarov/antigravity-workstation · [Скачать ZIP](https://github.com/m-safarov/antigravity-workstation/archive/refs/heads/main.zip)

### Совместимость версий Antigravity IDE (любая версия)

| Статус версии | Версии | Поведение установщика |
| --- | --- | --- |
| **Протестировано (`tested`)** | **2.9.0** (рекомендуется), **2.8.0**, **2.7.0**, **2.6.0** | Полная установка, native-автоматизация (`state.vscdb`) и проверка `Doctor` |
| **Проверка схемы (`schema-verified`)** | **Любые будущие и другие сборки** с неизменной встроенной схемой `unified_state_sync.proto` | Автоматическое криптографическое подтверждение SHA-256 схемы в `out/main.js` → полная установка **включая** native-автоматизацию и AI Tab OFF |
| **Портативный режим (`portable-fallback`)** | Будущие сборки, где формат `state.vscdb` изменился, или старые распознанные версии (`recognized`) | Установка **всего портативного профиля** (настройки, клавиши, расширения, шрифты, правила, skills, MCP, браузер) с безопасным пропуском прямых записей в `state.vscdb` без риска повредить базу IDE |

Официальные установщики с [antigravity.google/download](https://antigravity.google/download):
- **2.9.0:** [x64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.9.0-4671306730438656/windows-x64/Antigravity%20IDE.exe) · [ARM64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.9.0-4671306730438656/windows-arm64/Antigravity%20IDE.exe)
- **2.8.0:** [x64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.8.0-6733682917113856/windows-x64/Antigravity%20IDE.exe) · [ARM64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.8.0-6733682917113856/windows-arm64/Antigravity%20IDE.exe)
- **2.7.0:** [x64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.7.0-4507555968450560/windows-x64/Antigravity%20IDE.exe) · [ARM64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.7.0-4507555968450560/windows-arm64/Antigravity%20IDE.exe)
- **2.6.0:** [x64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.6.0-5526304964083712/windows-x64/Antigravity%20IDE.exe) · [ARM64](https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.6.0-5526304964083712/windows-arm64/Antigravity%20IDE.exe)

<a id="quick-start"></a>

## КОД 1 — чистая установка

Полный сброс и установка полного профиля с нуля (как на новом компьютере).

```powershell
& {
  $file = Join-Path $env:TEMP ('workstation-' + [guid]::NewGuid() + '.ps1')
  $url = 'https://raw.githubusercontent.com/m-safarov/antigravity-workstation/main/scripts/bootstrap.ps1'
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
- **Что меняет:** переносит старые папки IDE (`%APPDATA%\Antigravity IDE`, `%USERPROFILE%\.antigravity-ide`, `%USERPROFILE%\.gemini` кроме `backups`) в одну резервную копию `%USERPROFILE%\.gemini\backups\full-reset-<время>`, удаляет только пересоздаваемые кэши и логи, один раз инициализирует чистый профиль, проверяет архив в отдельной staging-папке, ставит профиль, удаляет временный архив и запускает `Doctor`.
- **Что сохраняется:** папки проектов и все прежние резервные копии в `%USERPROFILE%\.gemini\backups`.

## КОД 2 — обновление

Обновление существующего профиля на месте с сохранением личных настроек (подходит и для первой установки без сброса, если IDE уже открывалась хотя бы один раз).

```powershell
& {
  $file = Join-Path $env:TEMP ('workstation-' + [guid]::NewGuid() + '.ps1')
  $url = 'https://raw.githubusercontent.com/m-safarov/antigravity-workstation/main/scripts/bootstrap.ps1'
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

- **Что сохраняется:** ваши личные тема, шрифты, размер/толщина шрифта, направляющие, вид Error Lens, сторонние расширения, вход в аккаунт, чаты, память агента и папки проектов.
- **Надёжность:** фиксирует один точный commit SHA на всю установку, качает с реальным прогрессом (`MANCHO SETING ANTIGRAVITI`), проверяет целостность в изолированной staging-папке до изменения профиля, автоматически откатывает профиль при сбое и удаляет временные архивы после проверки.

| | КОД 1 — чистая установка | КОД 2 — обновление |
| --- | --- | --- |
| Когда выбирать | Нужен чистый профиль с нуля | Профиль уже стоит, нужно обновиться |
| Личные настройки, тема, шрифты, расширения | Переносятся в backup | **Сохраняются на месте** |
| Вход, чаты, память агента | Переносятся в backup — войди заново | **Сохраняются на месте** |
| Резервная копия | `%USERPROFILE%\.gemini\backups\full-reset-<время>` | `%USERPROFILE%\.gemini\backups\setup-backup-pre-install-<время>` |

## Что происходит в окне

Установщик показывает заголовок **`MANCHO SETING ANTIGRAVITI`** (широкий ASCII-баннер в широком терминале, одна строка в узком/CI/`NO_COLOR`) и реальный прогресс скачивания: **Windows и IDE → Node.js 24+ и Git → скачивание одного commit с прогрессом → проверка в staging → резервная копия → установка → итоговый Doctor → очистка временных файлов**. После зелёного **`DONE`** открой Antigravity IDE.

## Имя для GitHub (один раз на компьютере)

Открой **Explorer → GitHub** и нажми **«Войти в GitHub»** своим аккаунтом GitHub. Панель сама ставит в каждый проект GitHub твой логин и адрес `…@users.noreply.github.com`, поэтому все commits (из панели, терминала и агента) идут от твоего аккаунта GitHub, а не от аккаунта Google. Так делает и владелец репозитория, и каждый collaborator на своём компьютере.

Без входа панель принимает только адрес GitHub из git. Его можно задать один раз в Git Bash или Windows PowerShell (адрес `…@users.noreply.github.com` есть на странице [github.com/settings/emails](https://github.com/settings/emails)):

```bash
git config --global user.name "Имя Фамилия"
git config --global user.email "12345+login@users.noreply.github.com"
```

Почта Google (Gmail) подходит, только если она добавлена в аккаунт GitHub. Иначе GitHub показывает commit серым именем без профиля.

## Что входит в профиль

| Функция | Как работает |
| --- | --- |
| **Next.js, Node.js, React, TS, Tailwind** | Полная поддержка App Router, Server/Client компонентов, Node.js API, `Prisma` (`.prisma`), `YAML` (Docker Compose, GitHub Actions, OpenAPI), `tailwindCSS.classFunctions` (`clsx`, `cn`, `cva`, `twMerge`), file nesting для `next.config.*` и `vite.config.*`, исключение `.next`/`.turbo`/`coverage` из поиска и watcher |
| **Чистые закрывающие теги** | Устаревшее расширение `anteprimorac.html-end-tag-labels` удалено — больше нет серых надписей `/.flex.items-center...` после `</div>`; Tailwind IntelliSense, Highlight Matching Tag и встроенный `editor.linkedEditing` работают полностью |
| **Быстрый IntelliSense и Ctrl+Z** | AI ghost text и AI Tab выключены; обычный TS/JS IntelliSense ускорен (`--canUseWatchEvents`, `includePackageJsonAutoImports: "auto"`, `oxc.lint.run: "onSave"`), сохранён guard для `Ctrl+Z`/`Ctrl+Y` |
| **Темы и шрифты Aster Atelier** | **`Ctrl+Shift+P` → `Aster Atelier: Темы и шрифты`** — 11 палитр + темы IDE, яркость/контраст кода и 10 офлайн-шрифтов с лигатурами |
| **Командная панель GitHub и npm** | **Explorer → GitHub**: точный `upstream`, источник и назначение для Pull/Push, создание **Pull Request** с выбором `head`/`base`, удаление веток (**Local / Remote / Both**) с проверкой branch protection и worktrees, одна **подсказка commit по `Tab`** из реального diff (без авто-commit). Под ней — **npm-скрипты** |
| **Агент без лишних вопросов** | В режимах КОД 1 и КОД 2 применяются разрешённые полномочия full-stack workflow (Always Proceed, MCP Allow) с сохранением явных запретов (`deny` / `false`) и без расширения прав из произвольных репозиториев |
| **Каталог расширений (26)** | 21 расширение из Marketplace (`trackLatest`, включая `Prisma.prisma` и `redhat.vscode-yaml`) + 5 проверенных локальных VSIX (`Aster Atelier`, `Calm TypeScript`, `Git Branch Panel`, `Workstation Stability`, `Jelly Cursor`) |

## Опциональная локальная ИИ-помощь (восстановление и commit-подсказки)

Установка, обновление, `Doctor` и панель GitHub работают полностью **без ИИ** (`workstationStability.ai.enabled: false` по умолчанию). При желании можно подключить собственный API-ключ:

1. Настройки провайдера и модели (отдельно от секрета, в `settings.json` / **Settings → Workstation Stability**):
   - `workstationStability.ai.enabled`: `true`
   - `workstationStability.ai.provider`: `"gemini"` (или `"openai-compatible"`)
   - `workstationStability.ai.endpoint`: `"https://generativelanguage.googleapis.com/v1beta"`
   - `workstationStability.ai.model`: `"gemini-3.5-flash-lite"`
   - Пример-плейсхолдер (только для документации и `.env.example` — автоматически считается **незаданным**, никогда не коммитьте реальный ключ в Git): `[<YOUR_AI_API_KEY>]`
2. Сохранение ключа (выберите любой удобный локальный способ — ключ никогда не попадает в GitHub):
   - **Способ A (IDE `SecretStorage`, рекомендуется):** нажмите **`Ctrl + Shift + P`** → **`Workstation: Configure AI API Key`** и вставьте ваш личный ключ в скрытое поле (поддерживается замена, очистка; `Esc` сохраняет прежний ключ).
   - **Способ B (локальный личный `.env` вне Git):** создайте файл `%USERPROFILE%\.gemini\config\workstation-setup\.env` со строкой `WORKSTATION_AI_API_KEY=<ваш_ключ>` (см. шаблон [.env.example](.env.example)). Работает во всех проектах на компьютере, включая подсказки commit по `Tab` в панели **GitHub**, и не попадает в репозитории.
3. Проверка соединения:
   - Нажмите **`Ctrl + Shift + P`** → **`Workstation: Test AI Connection`**
   - Расширение выполнит минимальный запрос и покажет короткий redacted-статус (отсутствующий ключ, отклонённый ключ, недоступная модель или сбой сети).

> При запуске из внешнего терминала (вне IDE) `SecretStorage` недоступен — установщик использует безопасное детерминированное восстановление и никогда не сохраняет ключи в репозиторий.

## Если команда остановилась

| Надпись | Что сделать |
| --- | --- |
| `PAUSED: Antigravity is still running` | Окно покажет PID и путь и спросит **`Закрыть? (Y/N)`**. `Y` закроет окна и продолжит |
| `PAUSED: this is the terminal of an editor` | Открой обычный **Windows PowerShell** из меню Пуск и запусти команду там |
| `STOPPED: Antigravity IDE is not installed` | Установи Antigravity IDE 2.9.0 по ссылке выше и повтори |
| `STOPPED: Antigravity has never been started` | Для КОДА 2: открой IDE один раз, войди в аккаунт, закрой окна и повтори |
| `[SETUP FAILED]` | Временные файлы staging очищены, профиль откатывается из копии; текст диагностики уже в буфере для чата. Подробнее: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |

Нестандартная папка IDE? Перед командой вставь `$env:ANTIGRAVITY_INSTALL_DIR = 'D:\Папка с Antigravity IDE.exe'`.

## Установка через ИИ-агента

| Промпт | Для чего |
| --- | --- |
| [Windows](docs/prompts/WINDOWS-AI-SETUP.md) ([скачать](https://raw.githubusercontent.com/m-safarov/antigravity-workstation/main/docs/prompts/WINDOWS-AI-SETUP.md)) | Любой ИИ-агент с терминалом ставит профиль теми же командами КОД 1 и КОД 2 |
| [macOS](docs/prompts/MAC-AI-SETUP.md) ([скачать](https://raw.githubusercontent.com/m-safarov/antigravity-workstation/main/docs/prompts/MAC-AI-SETUP.md)) | Mac: агент переносит тот же профиль скриптом проекта |

## Что нового в 3.15.4

- **Каждый commit — от своего аккаунта GitHub, а не от аккаунта Google (GitHub Panel 1.9.4):** автор — аккаунт GitHub, вошедший в редакторе: у владельца — его commits, у collaborator-а — его собственные, из панели, терминала и агента. Без входа панель принимает из git только адрес GitHub (`…@users.noreply.github.com`): с почтой Google Commit и Push в проекте GitHub не выполняются, а панель просит «Войти в GitHub» и пишет «не аккаунт GitHub» в строке автора. Агент Antigravity больше не меняет `git config` и не подставляет имя или почту Google. Имя владельца, которое ранние версии подставляли в клон collaborator-а, удаляется.
- **AI-подсказки commit по `Tab` работают у всех из коробки (Stability 1.4.3 + GitHub Panel 1.9.2):** подключён защищённый Cloudflare Workers AI-прокси по умолчанию (`workstationStability.ai.proxyUrl`, модель `gemini-3.5-flash-lite`, upstream API-ключ полностью зашифрован на сервере Cloudflare и никогда не попадает в Git или на ПК пользователя; при офлайне или пустом `proxyUrl` работает умный локальный diff-анализатор с автообновлением `diffStamp` при каждом сохранении).
- **Официальная поддержка Antigravity IDE 2.9.0 (`2.9.0-4671306730438656`) + универсальная совместимость с любыми версиями IDE:** 2.9.0 добавлена в проверенный каталог (x64 и ARM64) и Windows CI smoke; будущие релизы автоматически проходят криптографическую проверку встроенной схемы `unified_state_sync.proto` (`schema-verified`), а при изменении формата `state.vscdb` безопасно устанавливается весь портативный профиль (`portable-fallback`) без остановки.
- **Обновлённый AI-помощник и мульти-remote Pull:** шаблон `.env.example`, исходники прокси [`services/commit-ai-proxy/`](services/commit-ai-proxy/README.md), выбор веток с нескольких remote в Pull и адаптивная ширина строки прогресса в узких терминалах.

[Все настройки](docs/SETTINGS-GUIDE.md) · [Расширения](docs/EXTENSIONS.md) · [Skills](docs/SKILLS.md) · [Как вернуть AI-подсказки](docs/AI-COMPLETION.md) · [Совместимость ПК](docs/HARDWARE-COMPATIBILITY.md) · [Восстановление через чат](docs/CHAT-REPAIR.md)
