# Контекст проекта для следующих сессий

Этот файл — краткая карта проекта и журнал последних изменений. Его цель: новая
сессия (человек или AI) за 5 минут понимает, что это за проект, что уже сделано,
какие настройки зачем стоят и где лежат ограничения. Подробности — в ссылках.

Последнее обновление: 16 ноября 2026, setup **3.11.1**, Aster Atelier **1.8.0**, Git Branch Panel **1.8.1**,
Calm TypeScript **3.4.0**, Workstation Stability **1.3.29**,
поддерживаемые IDE — **Antigravity IDE 2.7.0 и 2.6.0**.

## 1. Что это за проект

`antigravity-workstation` — установщик готового рабочего профиля для
**Antigravity IDE** (IDE Google на базе VS Code) под Windows. Одна команда в
Windows PowerShell скачивает свежий `main` с GitHub и ставит:

- настройки редактора (`config/settings.json`, 284 ключа), сочетания клавиш, `argv.json`;
- расширения (Prettier, Error Lens, Tailwind, сниппеты React и др.) и 4 своих
  расширения из `extensions/`: **Aster Atelier** (темы и шрифты), **Workstation
  Stability Helper** (применяет профиль внутри IDE), **Calm TypeScript**,
  **Git Branch Panel**;
- правила, навыки и агентов для чата Antigravity (`rules/`, `skills/`, `agents/`),
  MCP-серверы (`config/mcp/`), хуки;
- шрифты с лигатурами (через расширение Aster; системный JetBrains Mono ставится из файлов Aster).

AI-подсказки (серый ghost text) выключаются, обычный IntelliSense остаётся.
Перед изменениями создаётся резервная копия.

Основные папки: `bin/` (CLI), `lib/` (логика установщика), `config/`
(профиль), `extensions/` (свои расширения), `scripts/` (bootstrap и сборка),
`tests/` (тесты), `docs/` (документация). Правила работы — в `AGENTS.md`.

## 2. Как пользователь ставит профиль

Две команды из `README.md` (всегда из обычного **Windows PowerShell** из меню
«Пуск», не из терминала IDE):

| Команда | Что делает |
| --- | --- |
| **1** (`-CleanExtensions`) | Полный сброс: всё старое (настройки, расширения, вход, чаты) уходит в одну резервную копию; кэш и логи IDE (`Cache`, `CachedData`, `Code Cache`, `GPUCache`, `Dawn*Cache`, `CachedExtensionVSIXs`, `logs` …) после переноса удаляются и перечислены в `manifest.json` → `deletedCaches` (`lib/full-reset.js`). IDE один раз открывается на чистом профиле и закрывается сама, затем ставится профиль |
| **2** (без флага) | Установка или обновление: каждая настройка профиля ставится заново; изменённые файлы профиля заменяются (старые байты в `setup-payload-*`), удалённые из `main` — удаляются; VSIX переустанавливаются при смене версии/хеша; `RETIRED_EXTENSIONS: true` удаляются. Личные тема, шрифт, размер шрифта и настройки вне профиля остаются |

Ход работы `scripts/bootstrap.ps1`: проверка Windows и IDE → Node.js 24 и Git
(ставятся через winget) → загрузка `main` через git → (команда 1: сброс) →
установка (`bin/workstation-setup.js install`) → Doctor. Конец — зелёная рамка
**DONE** и `Doctor: 0 failures`.

### Частые остановки

- **`PAUSED: Antigravity is still running`** — с 3.11.0 `bootstrap.ps1`
  (`Get-IdeProcesses`, только текущий `SessionId`) печатает имя, PID и путь
  процессов и спрашивает `Закрыть? (Y/N)`: Y — `Stop-Ide` (просьба закрыться,
  через 15 с принудительно) и продолжение; N или неинтерактивный ввод — прежний
  PAUSED с кодом 3.
- **`PAUSED: this is the terminal of an editor`** — команда запущена из терминала IDE.
- **`STOPPED: this setup supports only Antigravity IDE 2.7.0 or 2.6.0`** — стоит
  другая версия IDE. См. раздел 7.

### Где установщик ищет IDE (диск C или D)

`Find-Ide` в `bootstrap.ps1` проверяет по порядку: переменную
`ANTIGRAVITY_INSTALL_DIR`, регистрацию в реестре (Uninstall), `PATH`
(`antigravity-ide.cmd`, `antigravity.cmd`, `agy.cmd`), затем
`%LOCALAPPDATA%\Programs`, `Program Files`, `Program Files (x86)` и на **каждом
несъёмном диске** (C:, D:, E: …) корень, `\Programs`, `\Program Files`, `\Apps`
с папками `Antigravity IDE` и `Antigravity`. Стандартная папка установщика
Google — `C:\Users\<имя>\AppData\Local\Programs\Antigravity IDE`. Для своей
папки пользователь пишет перед командой
`$env:ANTIGRAVITY_INSTALL_DIR = 'D:\Папка с Antigravity IDE.exe'`.

## 3. Что делают настройки профиля (главное)

Полный список — `config/settings.json`, объяснения — `docs/SETTINGS-GUIDE.md`.

| Группа | Значения | Зачем |
| --- | --- | --- |
| AI-подсказки | `editor.inlineSuggest.enabled: false` и выключатели AI-автодополнения | Ученик пишет код сам; IntelliSense (`cons` → `console`) остаётся |
| Сохранение и формат | `files.autoSave: afterDelay`, `files.autoSaveDelay: 1000`, `editor.formatOnSave: true`, `formatOnType: false`, Prettier по умолчанию | Сохранение через 1 с; код не переформатируется во время набора |
| Отступы | `editor.tabSize: 2`, `detectIndentation: false` (с 3.11.0; старое 3 мигрирует) | Как в индустрии; Prettier: 2 пробела, без `;`, двойные кавычки |
| Чистота файлов | `files.trimTrailingWhitespace`, `insertFinalNewline`, `trimFinalNewlines` (в `[markdown]` пробелы не трогаются) | Prettier с `afterDelay` работает только по Ctrl+S, а это — всегда |
| Клавиши | Ctrl+Shift+F — снова поиск по файлам (`RETIRED_KEYBINDINGS` удаляет старую привязку к формату); формат — Shift+Alt+F / Ctrl+Alt+F | Как во всех туториалах |
| Скобки и кавычки | `autoClosingBrackets/Quotes: always` | `(` → `()`, `"` → `""`, в JSX тоже |
| Подсказки | `editor.quickSuggestions` (в строках да, в комментариях нет), `wordBasedSuggestions: off`, `acceptSuggestionOnEnter: smart` | Подсказки по смыслу; Enter не съедает перевод строки |
| Теги | `editor.linkedEditing: true` вместо расширения Auto Rename Tag (`RETIRED_EXTENSIONS: true`) | Встроенное переименование пары тегов в HTML/JSX/TSX (TS ≥ 5.1) |
| Unicode | `unicodeHighlight.ambiguousCharacters/invisibleCharacters: true`, `allowedLocales: {_os:false,_vscode:false}`, без комментариев и строк | Кириллица внутри имён (`сount`) и невидимые символы подсвечиваются; русские слова — нет |
| Explorer | `explorer.fileNesting` (lock-файлы под `package.json`, `tsconfig.*`, конфиги под `vite.config.*`, `.env.*`) | Короткий список файлов |
| Вид | `minimap: false`, `renderLineHighlight: none`, `fontLigatures: true`, шрифт JetBrains Mono | Спокойный экран, лигатуры `=== !== =>` |
| Тема | `workbench.colorTheme: Visual Studio Dark` + `asterAppearance.theme: One Dark Pro` | Палитры Aster накладываются поверх базовой темы VS (см. раздел 4) |
| Терминал | профиль по умолчанию **Git Bash** | Команды как в учебных материалах |
| Агент | `chat.tools.terminal.autoApprove: {"/.*/": true}`; `~/.gemini/antigravity/settings.json` `permissions.allow` = `command(*)`, `read_file(*)`, `write_file(*)`, `read_url(*)`, `unsandboxed(*)`, `mcp(*)` (как нативный грант; `lib/config-merge.js` теперь добавляет их и при обновлении); MCP Allow, Secure Mode выключен | Пользователь 16.11.2026 явно попросил: агент не спрашивает. В `GEMINI.md` — правила Git Bash (пути `/d/react`, `--yes`, читать ошибку) |
| Ошибки | squiggles и Error Lens: ошибка `…b3` (~70%), предупреждение `…8c`, info `…73`, hint `…59`; фоны `#00000000`; Calm TypeScript 3.4.0 пишет те же цвета | Видны, но не режут глаз (раньше 15% — почти невидимы) |
| Языковые блоки | `[javascript]`, `[css]` … — только `editor.defaultFormatter` (+ `[markdown]`: quickSuggestions); `inlineSuggest:false` добавляет код (`mergeQuietSettings`) | Без 150 строк дублей |
| Jelly Cursor | `jellyCursor.*` | Плавный курсор |

**Личные настройки не затираются** (`lib/profile-settings.js`,
`PERSONAL_SETTINGS`): тема, шрифты всех поверхностей, `editor.fontSize`,
`editor.fontWeight`, `editor.fontLigatures`, `asterAppearance.fontStyle` и др.
Команда 2 оставляет их как есть.

## 4. Aster Atelier — темы, шрифты, начертания (`extensions/aster-appearance`)

Открывается: **Ctrl+Shift+P → Aster Atelier: Темы и шрифты**.

- **11 палитр Aster** (с 1.8.0, по запросу 16.11.2026): тёмные One Dark Pro
  (по умолчанию), Dracula, Tokyo Night, Catppuccin Mocha, GitHub Dark, Ayu
  Mirage, Nord; светлые GitHub Light, One Light, Catppuccin Latte, Light Owl.
  Удалены Quiet Light (тема IDE, скрыта), Night Owl, Panda, Everforest, Rose
  Pine Moon, Kanagawa, Vitesse, Gruvbox, Cobalt2, SynthWave 84, Solarized Light,
  Ayu Light — сохранённый выбор открывает ближайшую палитру
  (`palettes.legacy`). Галерея — ровно два раздела «Тёмные» / «Светлые» вместе
  с темами IDE (метка «IDE»), каждый по OKLab-яркости фона (`swatches.cjs`
  `arrange()`). Палитры в `palettes.cjs`, `themes/*.json` **генерируются**
  `node scripts/build-aster.cjs`. Тест различия: расстояние ≥ 0.10 в OKLab.
- **Скорость:** одно чтение настроек на применение, пишутся только изменённые
  ключи, быстрые клики объединяются (`wantedTheme` в `studio.cjs`) — тест
  проверяет точный список `config.update`.
- **Живой предпросмотр:** страница грузит `color.cjs` и тот же `codeInk()`,
  что и расширение; ползунки яркости/контраста сразу перекрашивают пример кода.
- **Ошибки в темах:** палитры используют ту же прозрачность, что профиль
  (`b3`/`8c`/`73`/`59`, `DIAGNOSTIC_ALPHA`); глобальные цвета профиля и
  пользователя побеждают.
- **Комментарии всегда цветные (зелёные)**, не серые и не прозрачные:
  `greenComment()` в `color.cjs` даёт зелёный (насыщенность OKLCH 0.12); если
  в теме строки уже зелёные — морская волна/бирюза. В темах IDE серый
  комментарий заменяется зелёным через правила `Aster Atelier · readable`
  (`swatches.cjs`). Контраст ≥ 5:1.
- **10 шрифтов** внутри расширения (OFL, URL и SHA-256 каждого файла в
  `fonts.json`, `scripts/fetch-aster-fonts.cjs` повторяем): JetBrains Mono,
  Fira Code, Cascadia Code, Victor Mono, Monaspace Krypton Var, Iosevka (только
  400 + курсив), IBM Plex Mono (без лигатур), Geist Mono, Rec Mono Linear (без
  кириллицы, 400/700), Maple Mono. Файлы JetBrains Mono (`Aster-jetbrainsmono-…`)
  установщик ставит и как системный шрифт (`config/font.json`) — не
  переименовывать. Шрифт, которого нет в списке, показывается как «… — текущий».
- **7 начертаний** (`FONT_STYLES` в `appearance.cjs`): Обычный, Курсив,
  курсивные комментарии, курсивные ключевые слова, курсив для обоих, жирные
  ключевые слова, жирные объявления — ни одно не меняет толщину. Толщина —
  кнопки − / + по реальным толщинам шрифта. Старые light/medium/semibold/bold/
  bold-italic переводятся при запуске (`LEGACY_STYLES`). Операторы `=> === &&`
  всегда прямые.
- `install-font.ps1` создаёт ключ реестра Fonts только если его нет (никогда
  `New-Item -Force` — это стёрло бы все пользовательские шрифты).
- Скриншоты `media/appearance-*.png` в расширении старые (1.0.1) —
  перерисовываются workflow «Aster actual Antigravity appearance».
- После любого изменения расширения: `node scripts/build-aster.cjs`,
  `node scripts/package-aster.cjs` (новый VSIX + `manifest.json` с хешами),
  повысить версию в `extensions/aster-appearance/package.json` и
  `config/extensions.json`, удалить старый VSIX.

## 4a. Git Branch Panel (`extensions/git-branch-panel`)

Панель **Explorer → GitHub**: создать репозиторий, подключить к GitHub (новый
репозиторий через аккаунт редактора `POST /user/repos` или ссылка на
существующий), Commit отмеченных файлов, Push (`-u` без upstream), Pull, ветки.
С 1.8.0 изменяющие команды идут **видимо** в терминале `GitHub` (Git Bash,
`src/git-terminal.js`, shell integration `executeCommand`, ждёт exit code,
timeout 2/5 мин); чтение состояния — в фоне. Без shell integration — прежний
фоновый `git` + лог в Output. Кавычки — `src/shell.js` (`'…'`, `$'…'`).

Вторая панель **Explorer → npm-скрипты** (`src/npm-scripts.js`, сразу под
GitHub): скрипты из `package.json` (корень или папки первого уровня), `dev`,
`start`, `build`, `preview`, `lint`, `test` сверху. Клик — `npm run <имя>` в
терминале `npm: <имя>` (профиль по умолчанию — Git Bash), один терминал на
скрипт, Stop/Restart; адрес `http://localhost:…` из вывода (shell integration)
— в описании и кнопкой «Открыть в браузере». Без shell integration через 3 с —
`sendText`.

- **Автор commit** (`src/identity.js`, `RepositoryIdentities.findAuthor`), по
  порядку: 1) аккаунт редактора, если его логин совпадает с владельцем
  `origin`; 2) запомненный автор этого проекта для этого владельца;
  3) публичный профиль владельца (`api.github.com/users/<владелец>`, только
  `type: User`); 4) владелец — организация: аккаунт редактора; 5) нет связи и
  ничего не запомнено: `null`, остаётся имя из git config. Имя пишется только
  в `git config --local` проекта с GitHub-`origin`. Проект без `origin` или на
  другом сервере не изменяется никогда.
- Пользователь просил именно так (14.11.2026): «от имени владельца
  репозитория, не смешивать с другим человеком». Следствие: в клоне чужого
  личного репозитория автором тоже будет его владелец; имя видно в строке
  «Автор commits» вверху панели.
- **Скорость:** чтения состояния идут параллельно (`collectState`); скрытая
  панель не обновляется; watcher пропускает `node_modules`, `.git/objects`,
  `.git/logs`, `*.lock`; опрос из webview раз в 20 с (раньше 5 с).
- После правок: поднять версию в `package.json` расширения,
  `node scripts/package-git-panel.cjs` (пересобирает VSIX и `manifest.json`),
  удалить старый `.vsix`, обновить версию в `config/extensions.json`.
- Тесты: `tests/test-github-panel*.mjs`, `tests/test-github-auth.mjs`
  (в тестах владелец `origin` и аккаунт — `octocat`).

## 5. Журнал изменений (ноябрь 2026)

| Версия setup / Aster | Что сделано |
| --- | --- |
| 3.5.0 / 1.4.0 | Исходное состояние: 17 тем, 5 шрифтов, панель GitHub |
| 3.6.0 / 1.5.0 | (коммит Codex) +5 шрифтов (Kode Mono, Monaspace ×4), 5 начертаний по толщине, первые цветные комментарии |
| 3.7.0 / 1.6.0 | +5 спокойных тем; комментарии стали явно зелёными; бледные имена в Nord не уходят в серый |
| 3.8.0 / 1.7.0 | +Fragment Mono; +5 начертаний по частям кода; предпросмотр показывает начертание |
| 3.9.0 / 1.7.0 | Поддержка Antigravity IDE 2.7.0 вместе с 2.6.0 (раздел 7) |
| 3.9.1 / 1.7.0 | Команда 1 повторяет просьбу закрыть IDE после первого запуска; smoke-тест ограничивает каждую README-команду 15 минутами (раздел 6) |
| 3.10.0 / 1.7.0 | Git Branch Panel 1.7.0: автор commit — владелец репозитория из `origin` (раньше — аккаунт редактора); проект без `origin` не изменяется; строка «Автор commits» в панели; меньше запусков git (раздел 4a) |
| 3.11.0 / 1.8.0 | Большое обновление по запросу 16.11.2026 (разделы 2–4a): Aster — 11 тем в двух разделах по яркости, 10 шрифтов, толщина отдельно (−/+), живой предпросмотр; Git Branch Panel 1.8.0 — npm-скрипты, git в терминале, «Создать репозиторий», «Подключить к GitHub»; профиль — Ctrl+Shift+F поиск, отступ 2, видимые ошибки, unicode, fileNesting, linked editing, +4 расширения; агент без вопросов; команда 1 удаляет кэш; PAUSED с Y/N; −4,4 МБ дубль JetBrains Mono; Calm TypeScript 3.4.0; Stability 1.3.29 |
| 3.11.1 / 1.8.0 | Git Branch Panel 1.8.1: команда, прерванная сигналом (exit 130 — Ctrl+C от Git Bash) до ответа git, повторяется в фоне вместо ошибки «git switch: exit code 130» |

Все версии проверены GitHub Actions (Setup checks, Native Windows IDE smoke,
Aster actual Antigravity appearance, Verify Aster VSIX build).

## 6. Тесты и проверка

- `npm test` — основной набор (`node:test`). Node 24 в облачной сессии —
  `/opt/node24/bin` (по умолчанию стоит 22). С 3.11.0 `lib/paths.js` на
  не-Windows использует обычные пути, поэтому в Linux падает только **~16
  тестов**, которым нужен Windows (`powershell.exe`, `tar.exe`, реестр).
  Правильная проверка — сравнить список падений до и после правок. Настоящая
  проверка Windows — в GitHub Actions после push. `pwsh` в облаке нет: код
  `.ps1` проверяется только в Actions.
- Тесты Aster: `node --test tests/test-aster-appearance.mjs tests/test-aster-studio.mjs tests/test-aster-themes.mjs tests/test-aster-comments.mjs`
  (2 теста VSIX падают на Linux из-за `tar.exe` — это нормально).
- `node scripts/audit-tracked-files.cjs` — `issues` должен быть пустым.
- Мусора `languagepacks.json` в корне больше нет (пути исправлены); если
  появится — удалить перед commit.
- Для шрифтов нужны `pip install fonttools uharfbuzz`
  (`ASTER_PYTHON=python3 node scripts/fetch-aster-fonts.cjs`).
- README-команды по-настоящему выполняются в Native Windows IDE smoke **только
  на push в `main`** (на pull request этот блок пропускается). Поэтому ошибка
  команды 1 видна только после push в `main`.

### Разбор зависания smoke-теста (14.11.2026, 2.7.0, windows-2022)

Команда 1 «висела» 35 минут, пока GitHub не отменил job. Цепочка:

1. После сброса bootstrap (`Initialize-Ide`) запускает IDE на новом профиле и
   один раз, через 10 с, просил её закрыться (`CloseMainWindow`). Если окно ещё
   не показано (2.7.0 на медленном раннере), просьба терялась, и через 90 с IDE
   завершалась принудительно.
2. После принудительного завершения у `state.vscdb` остаётся `-wal`, поэтому
   агентские настройки откладываются: установщик запускает отдельный
   фоновый процесс (`lib/agent-automation.js`, до 24 ч), который ждёт
   штатного закрытия IDE.
3. Windows-процессы наследуют все наследуемые дескрипторы родителя
   (PowerShell → node → фоновый процесс). Тест читал вывод команды через pipe,
   и фоновый процесс держал этот pipe открытым — тест ждал конца вывода вечно,
   хотя сама команда уже закончилась.

Исправлено в 3.9.1: просьба закрыться повторяется каждые 5 с до 120 с (IDE
закрывается штатно, `-wal` нет, ничего не откладывается); smoke-тест пишет
вывод команды в файлы и ждёт процесс с лимитом 15 мин (при зависании печатает
хвост вывода и список процессов). У пользователя в обычном окне PowerShell
pipe нет, поэтому такого зависания у него не было; в худшем случае разрешения
агента применялись после следующего закрытия IDE.

## 7. Версии IDE: 2.7.0 и 2.6.0 (и как добавить следующую)

С setup **3.9.0** поддерживаются **две** проверенные версии: **2.7.0**
(рекомендуемая, её ссылку даёт bootstrap) и **2.6.0**. Обновлять 2.6.0 не
обязательно: обе команды README работают с любой из них, IDE может стоять на
любом диске.

Что проверено для 2.7.0 (build `2.7.0-4507555968450560`, commit
`71bedb45923debaf49871bdcb7c7d3a47918e247`):

- движок VS Code тот же — **1.107.0**, поэтому реестр настроек и цветов не
  менялся; `product.json`: те же `nameShort` «Antigravity IDE» и папка
  данных `.antigravity-ide` (профиль в `%APPDATA%\Antigravity IDE`);
- встроенная схема `unified_state_sync.proto` **байт в байт та же**
  (SHA-256 `b70f135c…`), значения enum (EAGER=3, TURBO=2, tabEnabled=1,
  tabToJump=2) и ключи `state.vscdb` (`agentPreferences`, `tabPreferences`,
  `browserPreferences`, `overrideStore`) не изменились — адаптер
  `uss-int32-agent-tab-v1` подходит без правок;
- `out/main.js` у x64 и ARM64 одинаковый (как и в 2.6.0), его хеш получен
  установкой официального установщика на GitHub-раннере Windows
  (Native Windows IDE smoke).
- Новшества 2.7.0 (пилюли терминала в чате, меню быстрого доступа,
  переименованные команды diff, правки diff/Auto Save/входа) настроек профиля
  не задевают.

Изменения кода для двух версий:

- `scripts/bootstrap.ps1`: `$IdeVersions = @('2.7.0', '2.6.0')`, первая —
  ссылка для скачивания; `Find-Ide` и `Test-Ide` принимают любую из списка.
- `lib/native-compatibility.js`: `SUPPORTED_IDE_VERSIONS` (первая —
  рекомендуемая, `SUPPORTED_IDE_VERSION`). Проверка схемы больше не зависит
  от имени функции минификатора (`=Uo`, `=Ra`, `=va` …): ищутся все
  встроенные дескрипторы с этим именем файла; хотя бы один должен быть, и все
  должны совпадать с проверенным хешем.
- `config/native-compatibility.json`: 4 сборки (2.7.0 и 2.6.0 × x64/arm64).
- `scripts/macos-setup.cjs`: `IDE_VERSIONS`.
- Smoke-тест Windows идёт по матрице 2.6.0 и 2.7.0.

Как добавить следующую версию: скачать официальные установщики
(`dl.google.com/edgedl/release2/j0qc3/antigravity/stable/<версия>-<build>/windows-<arch>/Antigravity%20IDE.exe`),
посчитать SHA-256, сравнить схему protobuf (удобно по Linux-архиву той же
версии, но хеш `main.js` у Linux **другой** — Windows-хеш берётся с
Windows: smoke-тест при несовпадении печатает настоящий хеш), добавить версию
в начало `$IdeVersions`, `SUPPORTED_IDE_VERSIONS`, `IDE_VERSIONS`, сборки в
каталог, строку в матрицу smoke, ссылки в README, раздел source-evidence в
`docs/AGENT-AUTOMATION.md` и тесты. Если схема изменилась — нужен новый
адаптер, иначе можно повредить данные агента. Инструмент `innoextract` 1.9
не читает установщики Inno Setup 6.4 (2.7.0).

## 8. Известные слабые места (не исправлены)

Исправлены в 3.11.0: PAUSED показывает процесс и спрашивает Y/N; Stability
Helper 1.3.29 восстанавливает управляемое значение, вернувшееся к default
(один раз на запрос, `editorProfileRestored`). Статус «Workstation: N» —
число управляемых настроек, чьё действующее значение отличается от профиля.

Остаются:
- **Не проверено в живой IDE на Windows:** shell integration Git Bash
  (`--login -i`) для терминалов `GitHub` и `npm: …` — при её отсутствии
  работают запасные пути (фоновый git, `sendText`) без поиска адреса.
- **Удалённый из шаблона MCP-сервер** остаётся у пользователя: установщик не
  помнит, какими серверами владеет.
- **Подсветка unicode:** слово только из «похожих» кириллических букв (`с`,
  `бо`) в JSX-тексте будет подсвечено.

## 9. Правила работы в репозитории

- `AGENTS.md`: Node 24+, npm 10+, LF, отступ 3 (в `lib/` — 2, CommonJS),
  короткие commit-сообщения в повелительном наклонении, личные настройки не
  трогать, секреты не коммитить.
- Пользователь просит отправлять изменения **прямо в `main`** (команды 1/2
  скачивают `main`). При изменении расширения обязательно поднимать его версию
  и версию setup, иначе установщик не заменит старую.
- Облачная сессия **не может удалять ветки** на GitHub (403) — это делает
  пользователь на странице `/branches`.
- Перед работой проверить, нет ли в `main` новых коммитов (пользователь иногда
  работает параллельно через Codex) — строить поверх них, не затирать.
