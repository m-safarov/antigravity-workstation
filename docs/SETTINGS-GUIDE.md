# SETTINGS GUIDE — полная карта настроек Antigravity Workstation

Этот документ — единая точка правды для любого ИИ или разработчика: **какая настройка существует, что она реально делает, зачем она нужна и какой баг решает**. Читай его перед тем, как менять что-либо в `config/`.

Репозиторий: `m-safarov/antigravity-workstation`. Продукт — установщик/менеджер настроек для Antigravity IDE (форк VS Code, engine 1.107) + собственные расширения (Aster Atelier, Workstation Stability, Calm TypeScript, Git Branch Panel).

---

## 1. Как настройки попадают к пользователю (pipeline)

```
GitHub main → scripts/bootstrap.ps1 (Windows 10/11)
  → git скачивает последний commit main (только изменения; старый launcher сам передаёт работу новому)
  → bin/workstation-setup.js install (lib/installer.js)
      ├─ backup старых settings в ~/.gemini/backups/...
      ├─ mergeSettings(): managed config + личные значения пользователя
      ├─ пишет settings.json, keybindings.json, argv.json профиля IDE
      └─ ставит 26 расширений каталога (gallery → latest stable; local VSIX → SHA-pin)
  → Doctor проверяет результат (цель: 80 PASS / 0 FAIL)
```

Три источника правды в репозитории:

| Файл | Что это | Кто меняет |
|---|---|---|
| `config/settings.json` | managed-настройки редактора (283 ключа) | человек/ИИ руками |
| `config/keybindings.json` | managed-горячие клавиши | человек/ИИ руками |
| `config/extensions.json` | каталог 26 расширений (21 gallery + 5 local VSIX) | человек/ИИ руками |
| `extensions/aster-appearance/themes/*.json` | 11 палитр Aster — **GENERATED** из `palettes.cjs` | только `scripts/build-aster.cjs` |
| `extensions/*/manifest.json` | SHA-256 pin упакованных VSIX | только `scripts/package-*.cjs` |

## 2. Права владения (ownership) — САМОЕ ВАЖНОЕ

`lib/profile-settings.js → mergeSettings(current, managed)` решает, кто выигрывает:

- **Personal-ключи** (пользователь главнее): `workbench.colorTheme`, все 10 font-family ключей из `FONT_FAMILY_KEYS`, `editor.fontSize/fontWeight/fontLigatures`, `terminal.integrated.fontWeight`, `editor.guides.*`, `errorLens.*`, `git.autofetch`, `prettier.requireConfig`, `editor.semanticTokenColorCustomizations`. Единый список — `PERSONAL_SETTINGS` в `lib/profile-settings.js`.
- **`workbench.settings.applyToAllProfiles`** — особый случай: union (managed-дополнения добавляются, пользовательские записи сохраняются).
- **`workbench.colorCustomizations`** — глубокий merge: managed-дополнения приходят, личные значения не затираются.
- **Языковые блоки `[typescript]` и т.п.** — в обычном режиме значение пользователя выигрывает, managed-дополнения заполняют остальное; в `--apply-profile`/`--quiet-completion` managed-политика главнее. С 16.11.2026 блоки содержат только `editor.defaultFormatter` (у `[markdown]` — ещё свои значения, §3.6). 12 ключей, которые прежние setup повторяли в каждом блоке (`editor.tabSize`, `insertSpaces`, `detectIndentation`, `tabCompletion`, `snippetSuggestions`, `suggest.showSnippets`, `suggestOnTriggerCharacters`, `quickSuggestions`, `autoClosing*`), уходят из managed-блоков: команда 2 и helper убирают их всегда, обычное обновление — только если там ещё значение, записанное setup (`LANGUAGE_POLICY_VALUES` в `extensions/workstation-stability/profile.cjs`). Блоки других языков (`[python]`) не трогаются.
- **Старые значения setup** (`RETIRED_MANAGED_VALUES`, `RETIRED_MANAGED_COLORS`, `RETIRED_KEYBINDINGS` в `lib/profile-settings.js`): значение, совпадающее с записанным прежним setup (например `editor.tabSize: 3`, цвета ошибок с alpha `26`/`33`, `ctrl+shift+f → formatDocument`), переходит на текущее; любое другое значение — личный выбор и остаётся.
- Остальные managed-ключи — значение из `config/settings.json`.

Режимы установки: `install` без флагов (личные значения остаются) / `--apply-profile` (команда 2 из README: каждая managed-настройка и сочетание клавиш ставятся заново; тема, шрифты, размер шрифта, направляющие и вид Error Lens остаются) / `--reset-profile` (команда 1: профиль с нуля) / `--quiet-completion` (выключить AI completion) / `--auto-approve` (агент работает без вопросов: native Always Proceed и полный allow-список, §3.10; обе команды README его передают).

Исторический баг (исправлен, не ломай обратно): старый код подставлял копию пользователя вместо managed для объектных ключей → новые managed-ключи никогда не доходили до старых установок. Регрессия-тест: `tests/test-personal-config-preservation.mjs → "Upgrade delivers new managed appearance keys"`.

## 3. config/settings.json — по группам

### 3.1 Курсор и спокойный редактор
- `editor.cursorBlinking: smooth`, `editor.cursorSmoothCaretAnimation: on`, `editor.cursorWidth: 2` — плавный тонкий курсор; тест `test:calm-typescript:editor` проверяет анимацию и ширину **2px** в реальном рендере.
- `editor.renderLineHighlight: none`, `editor.matchBrackets: never`. Линия области `{ }` видна только у блока под курсором (`editor.guides.bracketPairs` и `bracketPairsHorizontal: active`, `highlightActiveBracketPair: true`); линии отступов выключены.
- `editor.minimap.enabled: false`, узкие скроллбары 8px, smoothScrolling везде, `editor.lineHeight: 25`, `letterSpacing: 0.3`, padding 12/12 — комфортная плотность кода.

### 3.2 Видимые, но спокойные диагностики (Error Lens) — решение «жёлтых блоков»
Проблема: расширение Tailwind публикует подсказки вида `The class 'gap-[24px]' can be written as 'gap-6'` как diagnostics (Warning/Info), а Error Lens рисовал их **сплошными оранжевыми блоками на всю строку**.

Решение в `workbench.colorCustomizations`:
- `errorLens.{error,warning,info,hint}Background` + `...BackgroundLight` + `...MessageBackground` + `...RangeBackground` = `#00000000` (16 ключей) — **все** фоны полностью прозрачны, во всех темах (Light-варианты нужны, т.к. Error Lens берёт их для светлых тем; их отсутствие и было причиной блоков).
- Текст и подчёркивания с 16.11.2026 видны, но не режут глаз: ошибки ≈70% (alpha `b3`), предупреждения ≈55% (`8c`), info ≈45% (`73`), hint ≈35% (`59`). Подчёркивания `editor{Error,Warning,Info}.foreground` — один набор для любой темы: средние тона `#ef4444`, `#f59e0b`, `#0ea5e9`, которые читаются и на тёмном, и на светлом фоне. Текст Error Lens: в тёмных темах `#f87171`, `#fbbf24`, `#7dd3fc`, `#94a3b8` (`errorLens.*Foreground`), в светлых (`errorLens.*ForegroundLight`) — более тёмные `#dc2626`, `#d97706`, `#0284c7`, `#64748b` с той же прозрачностью. Раньше было alpha `26` (≈15%) — почти невидимо; такие значения у старых установок обновление заменяет (`RETIRED_MANAGED_COLORS`), личные цвета остаются.
- ⚠️ Calm TypeScript (`QUIET_COLORS` в `extensions/calm-typescript/extension.cjs`) при `calmTypeScript.quietMode: true` сам записывает эти цвета; его значения должны совпадать с config (тест `test-calm-typescript.mjs` сверяет). Палитры Aster задают свои theme-scoped цвета, которые выигрывают у глобальных.
- `errorLens.enabled: true, followCursor: allLines, delay: 500` — подсказки работают, но не перекрывают код.
- `anteprimorac.html-end-tag-labels` выведен в 3.14.0 (рисовал длинные серые Tailwind-подписи у закрывающих тегов `</div>/.flex...`); ключи `htmlEndTagLabels.*` и `workbench.colorCustomizations["htmlEndTagLabels.labelColor"]` удаляются при обновлении (`RETIRED_SETTING_PREFIXES` и `RETIRED_MANAGED_COLORS`), а Tailwind IntelliSense, Highlight Matching Tag и `editor.linkedEditing` остаются.

⚠️ Правило: эти ключи живут **в двух местах** — здесь и в каждой из 11 палитр Aster (`extensions/aster-appearance/themes/*`, generated). Менять только через `scripts/build-aster.cjs`, не руками в темах.

### 3.3 Подсказки и сниппеты (настроены под React/TS-разработку)
- `editor.quickSuggestions {other: true, comments: false, strings: true}` + delay 10 — автоподсказки без Ctrl+Space.
- `editor.tabCompletion: on`, `snippetSuggestions: top` — Tab работает со сниппетами.
- `editor.inlineSuggest.enabled: false` — без «призрачного» автодополнения (мешал обучению и печатал за пользователя); в режимах README установщик (`lib/quiet-completion.js`) сам добавляет его в JS/TS-блоки и во все существующие языковые блоки, поэтому блоки в `config/settings.json` его не повторяют.
- `editor.suggest.showWords: false`, `matchOnWordStartOnly: false` — без мусорных словесных подсказок; показ методов/классов/сниппетов включён точечно.
- `acceptSuggestionOnCommitCharacter: false`, `acceptSuggestionOnEnter: smart` (с 16.11.2026) — Enter принимает подсказку, только если она меняет текст, иначе это новая строка; Tab принимает всегда.
- `editor.wordBasedSuggestions: off` — слова из файла не засоряют список.

### 3.4 Emmet + Tab (решение «Tab не принимал сниппет»)
- `emmet.triggerExpansionOnTab: true`, `showExpandedAbbreviation: always`, `showSuggestionsAsSnippets: true` — Emmet-сокращения расширяются Tab и видны в меню.
- **Конфликт, который это создавало**: Tab в меню подсказок запускал Emmet вместо принятия выбранного React-сниппета (`rfc` → `<rfc></rfc>` вместо компонента). Решение — биндинг в `keybindings.json` (см. §4), а не отключение Emmet.

### 3.5 TypeScript/JavaScript поведение
- `*.validate.enable: true` — красные ошибки валидации включены.
- `*.suggest.autoImports: true`, `updateImportsOnFileMove: always` — автоперенос импортов.
- `*.suggest.paths: false`, `classMemberSnippets: false`, `completeJSDocs: false`, `completeFunctionCalls: false` — убраны навязчивые подсказки (пути даёт npm-intellisense/path-intellisense).
- `preferences.quoteStyle: double`, `importModuleSpecifier: shortest` — единый стиль. `jsxAttributeCompletionStyle: auto` — атрибут-строка получает `""` (`className=""`), функция, число, массив и объект — `{}` (`onClick={}`).
- `typescript.tsserver.maxTsServerMemory` — **вычисляется установщиком** из RAM машины (`lib/system-resources.js`), не хардкодить.

### 3.6 Форматирование — Prettier + 2 пробела
- `editor.defaultFormatter: esbenp.prettier-vscode` + во всех языковых блоках; `formatOnSave: true (file)`, `formatOnPaste: false`, `formatOnType: false`.
- `editor.tabSize: 2, insertSpaces: true, detectIndentation: false` + `prettier.tabWidth: 2, semi: false, singleQuote: false, printWidth: 100, trailingComma: es5` — единый стиль: **2 пробела** (с 16.11.2026, раньше 3), без точек с запятой, двойные кавычки. `.editorconfig`/`.prettierrc` проекта главнее. Стиль самого этого репозитория (3 пробела) не меняется.
- Языковые блоки `[js|jsx|ts|tsx|html|css|scss|json|jsonc|markdown]` содержат только `editor.defaultFormatter`: встроенные расширения VS Code 1.107 не задают для этих языков своих отступов, подсказок и скобок (их `configurationDefaults`: css/scss/html/json — только `editor.suggest.insertMode`, json — `quickSuggestions.strings`), поэтому глобальные значения действуют. Исключение — `[markdown]`: markdown-language-features выключает `editor.quickSuggestions`, блок возвращает их; плюс `files.trimTrailingWhitespace: false` (два пробела в конце строки — перенос) и `editor.unicodeHighlight.ambiguousCharacters: false` (русский текст не подсвечивается).
- Удалены ключи, равные значениям по умолчанию VS Code 1.107 без цели (`editor.parameterHints.enabled`, `bracketPairColorization.enabled`, `hover.enabled`, `selectionHighlight`, `occurrencesHighlight`, `autoSurround`, `suggest.insertMode/showIcons/preview/snippetsPreventQuickSuggestions`, `workbench.productIconTheme`, `typescript.preferences.preferTypeOnlyAutoImports`, `*.updateImportsOnPaste.enabled`).
- `oxc.enable.oxfmt: false` — Oxc-форматтер не конкурирует с Prettier.

### 3.7 Tailwind CSS IntelliSense
- `tailwindCSS.classAttributes: [class, className]`, `tailwindCSS.classFunctions: [clsx, cn, cva, twMerge]`, `emmetCompletions: true`, `includeLanguages` для js/ts/tsx — классы подсказываются в React и Next.js (включая `cn(...)` / `clsx(...)` / `cva(...)` / `twMerge(...)`).
- `lint.*` — конфликты классов warning, остальное error.
- Подсказки «can be written as» приходят отсюда — их вид управляется Error Lens (см. §3.2).

### 3.8 Шрифты — «весь IDE одним шрифтом»
- `editor.fontFamily: 'JetBrains Mono', 'Cascadia Code', monospace`, `fontSize: 15`, `fontWeight: 400`, `fontLigatures: true`, `lineHeight: 25`.
- Все 10 font-family ключей (`editor`, `terminal.integrated`, `debug.console`, `chat`, `chat.editor`, `editor.inlayHints`, `editor.inlineSuggest`, `notebook.output`, `notebook.markup`, `scm.input`) уже в `config/settings.json` = `'JetBrains Mono', monospace` — на чистом ПК шрифт сразу везде, без открытия студии Aster. `terminal.integrated.fontSize: 14`, cursor line/2px.
- `workbench.settings.applyToAllProfiles` — **12 ключей-семейств** (`editor.fontFamily`, `terminal.integrated.fontFamily`, `debug.console.fontFamily`, `chat.editor.fontFamily`, `chat.fontFamily`, `editor.inlayHints.fontFamily`, `editor.inlineSuggest.fontFamily`, `notebook.output.fontFamily`, `notebook.markup.fontFamily`, `scm.inputFontFamily`, `editor.fontSize`, `window.zoomLevel`) — шрифт применяется ко **всем профилям** IDE и ко всем поверхностям, которые вообще регистрирует хост. Список font-family ключей — единственный источник `FONT_FAMILY_KEYS` в `extensions/aster-appearance/appearance.cjs`: его используют студия Aster и установщик, а тест проверяет, что каждый ключ задан в config и в `applyToAllProfiles`.
- ⚠️ Не добавлять туда ключи, которых нет в registry хоста: legacy `notebook.outputFontFamily` строка в коде хоста есть, но настройка незарегистрирована — проверено живым CI-тестом, из-за неё установка падала.
- Ограничение (не баг): шрифт самого workbench-хрома (explorer, вкладки) настройкой не меняется — в этом IDE нет поддерживаемого API.

### 3.9 Терминал и Explorer
- `terminal.integrated.defaultProfile.windows: Git Bash` + профиль с `${GIT_BASH_PATH}` — путь **подставляет установщик** (`lib/paths.js`), Git Bash обязателен.
- `explorer.fileNesting.enabled: true`, `expand: false` + `explorer.fileNesting.patterns` (обновлено в 3.14.0): под `package.json` — lock-файлы, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`; под `tsconfig.json` — `tsconfig.*.json`; под `vite.config.*` и `next.config.*` — configs `vitest`, `eslint`, `prettier`, `postcss`, `tailwind`, `next-env.d.ts`, `.oxlintrc.json`; под `.env` — `.env.*`. `index.html` остаётся на виду. Личные шаблоны сохраняются (объект сливается, `MERGED_SETTINGS`).
- `files.trimTrailingWhitespace`, `files.insertFinalNewline`, `files.trimFinalNewlines: true` — при сохранении нет пробелов в конце строк и ровно один перевод строки в конце файла; в Markdown хвостовые пробелы остаются.
- `explorer.confirmDelete/confirmDragAndDrop/confirmPasteNative: false` — без лишних подтверждений; `decorations.colors/badges: false` (и `workbench.editor.decorations.colors/badges: false` для вкладок: имя файла с ошибкой не красится в красный) — чистое дерево файлов.

### 3.10 Безопасность и AI
- `security.workspace.trust.untrustedFiles: open` — IDE не блокирует файлы (доверие управляется осознанно).
- `chat.tools.terminal.autoApprove: {"/.*/": true}` — по явному запросу пользователя (16.11.2026: «задачу выполнять без вопросов») любая команда терминала разрешена без спроса. Записи пользователя со значением `false` сохраняются при обновлениях, встроенные запреты VS Code (`rm`, `del`, `kill`, `curl` …) действуют.
- `config/antigravity-settings.json` → `~/.gemini/antigravity/settings.json`: `permissions.allow` = `command(*)`, `read_file(*)`, `write_file(*)`, `read_url(*)`, `unsandboxed(*)`, `mcp(*)` — тот же набор, что native-грант `permission_grants_global` (`AUTO_ALLOW` в `lib/mcp-permissions.js`). Раньше там был узкий список (`command(npx tsc --noEmit)`, `command(git *)` …), и агент спрашивал про остальные команды (например `npx shadcn@latest add dialog`). Только при `--auto-approve` (обе команды README): `mergeUserConfiguration` добавляет недостающие гранты к списку пользователя, его `deny` и прочие поля остаются; Doctor показывает «Agent allow list» (pass, без opt-in — info).
- Правила агента (`rules/GEMINI.template.md`, раздел Terminal): проверять фактический shell (`PS ...>` / PowerShell — пути Windows и `& 'C:\...\tool.exe'`, никогда `/c/...`; Git Bash в терминале IDE — пути `/d/react` или `D:/react` и `"/c/..."`); без лишнего `cd`; non-interactive флаги (`--yes`, `--template`); при exit code ≠ 0 сначала читать ошибку. Спрашивать только перед необратимым (удаление файлов шефа, force-push, hard reset).
- `inlineChat.holdToSpeech: false` и беззвучные `accessibility.signals.voiceRecordingStarted/Stopped` — голосовые фичи IDE не срабатывают случайно (это же дублируется негативными keybindings, §4). Ключи `accessibility.voice.autoSynthesize/keywordActivation/speechTimeout` убраны в 3.4.0: Antigravity 2.6.0 их не регистрирует (проверка всех настроек в настоящей IDE после команды 1), IDE их игнорировала и подчёркивала как неизвестные; установка удаляет их и из старых профилей.

### 3.10a Unicode-безопасность и парные теги (16.11.2026)
- `editor.unicodeHighlight.ambiguousCharacters: true`, `invisibleCharacters: true` — подсвечиваются кириллические двойники в коде (`сount` с русской `с`, набранной не в той раскладке) и невидимые символы (zero-width space из чатов и сайтов).
- `editor.unicodeHighlight.allowedLocales: {"_os": false, "_vscode": false}` — обязательно: по умолчанию `_vscode` = язык интерфейса (`ru` с русским language pack), а таблица VS Code для локали `ru` не считает `а б г е о р с у х` двусмысленными, т.е. `сount` не подсвечивался бы (проверено по `unicodeHighlighter.ts` и `AmbiguousCharacters` в `src/vs/base/common/strings.ts` VS Code 1.107).
- `includeComments: false`, `includeStrings: false`, `nonBasicASCII: false` — комментарии и строки не красятся. Вне них русское/таджикское слово тоже не подсвечивается, если в нём есть хотя бы одна буква без латинского двойника (и, л, м, н, т …) и нет латиницы — правило VS Code. Остаток: слово только из `а б г е о р с у х` (например «с», «бо») в JSX-тексте подсвечивается. В `[markdown]` двусмысленные символы выключены, в `[plaintext]` их выключает сама IDE.
- `editor.linkedEditing: true` вместо расширения Auto Rename Tag: HTML (html-language-features) и JSX/TSX (TypeScript ≥ 5.1, команда `linkedEditingRange`; VS Code 1.107 несёт TypeScript 5.9) переименовывают парный тег сами. Auto Rename Tag убран из каталога; у старых установок он архивируется (`RETIRED_EXTENSIONS` → `true`), его `auto-rename-tag.*` удаляются (`RETIRED_SETTING_PREFIXES`).

### 3.11 Вычисляемые ключи (не хардкодить!)
- `jellyCursor.workbenchHtmlPath: ${ANTIGRAVITY_WORKBENCH_HTML}` — установщик подставляет путь к workbench.html найденной IDE; по нему Workstation Stability находит файл для патча Jelly Cursor.
- `terminal.integrated.profiles.windows.Git Bash.path: ${GIT_BASH_PATH}` — подставляется из найденного Git Bash.
- `typescript.tsserver.maxTsServerMemory` — из объёма RAM.
- **Jelly Cursor** (`iranon.jelly-cursor` 0.0.8, MIT) — ставится всегда как local VSIX `extensions/jelly-cursor/`. Upstream объявляет engine `^1.120.0`, и Antigravity (1.107) его отклоняет, хотя использует только старые API. Пакет пересобран `scripts/package-jelly-cursor.cjs`: код байт-в-байт upstream, изменён только engine → `^1.107.0` (`upstream.json` хранит hash оригинала; тест `test-jelly-cursor.mjs`). Проверено живым CLI: upstream — «Failed Installing», пересобранный — «successfully installed».
- Профиль для долгой работы с кодом — мягкий и плавный, глаза не устают: `animationMode: smooth` — курсор просто плавно «плывёт» к новому месту без растяжения и пружины (`midSpeed 0.26`, около четверти секунды), `shapeStyle: rounded`, слабое свечение только при движении (`glowOpacity 0.3 / glowIntensity 1 / glowSize 8`), без следа (`trailEnabled: false`, нет «призрачных» отметок). В покое курсор мягко мигает вместе с родным `cursorBlinking: smooth` и в нижней точке остаётся едва видимым (`minAlpha 0.12`). IDE мигает всем слоем `.cursors-layer`, а Jelly читает прозрачность самого `.cursor`, поэтому без помощи нарисованный курсор не мигал: Stability 1.3.24 после каждой установки патча дописывает в `jelly-cursor.js` короткий блок `workstation-blink`, который переносит прозрачность слоя активного редактора на курсор Jelly. Сама IDE прекращает мигание после 20 циклов (около 10 секунд покоя); с Stability 1.3.25 этот блок продлевает мягкое мигание (`animation-iteration-count: infinite`), а при наборе текста курсор, как обычно, не мигает. Проверено в живой IDE через локальный порт отладки: через 15 секунд после клика прозрачность курсора Jelly продолжает идти 1 → 0.39 → 0.12 → 0.74 → 1. Выключено всё, что мелькает вокруг текста: ripple (круг при клике), spark (`sparkAmount 0`, пузырьки), landingPulse, rainbow, gradient и напоминания Jelly (`reminders: false` — патч ставит Stability). Прыжки дальше 400 px не анимируются. `cursorColor`/`glowColor` = `""` — цвет курсора из темы. Значения, которые записали прошлые версии setup, обновление переводит на этот профиль (`RETIRED_MANAGED_VALUES` в `lib/profile-settings.js`); любое другое значение — личный выбор и сохраняется.
- DOM-патч ставится **сам**: Workstation Stability при старте IDE (`jelly-patch.cjs`) вызывает родную команду `jellyCursor.installDomPatch`, если маркера в `workbench.html` нет (первая установка или обновление IDE стёрло патч). Эффекты видны после **второго** запуска IDE. Проверено на копии Antigravity 2.6.0: патч поставлен автоматически, после перезапуска слой `.jelly-cursor-layer` рисует курсор с trail, в строке состояния «✓ Jelly Cursor».
- **Интерфейсный блок** (`extensions/workstation-stability/workbench-ui.cjs`, Stability 1.3.29): `workbench.html` загружает собственный `workstation-ui.js`. Он скрывает строки «Ctrl+L for Agent» и «Explain and Fix Problem» и раз в секунду читает `workstation-ui.css`, который пишет Aster Atelier, — галочка «шрифт для всего интерфейса» меняет шрифт меню, панелей и вкладок без перезапуска. Установщик (команды 1 и 2) добавляет блок, пока IDE закрыта, поэтому он работает с первого запуска; после обновления IDE его возвращает Stability через 60 секунд после старта (тогда — после одного перезапуска). Раньше этот код дописывался в `jelly-cursor.js` и работал только после патча Jelly и перезапуска; старая копия удаляется. Doctor проверяет блок и сумму в `product.json`.
- Целостность IDE: любой патч `workbench.html` вызывает «installation appears to be corrupt», а у Antigravity в этом уведомлении нет кнопки «Don't Show Again». По явному разрешению пользователя Stability (`syncIntegrity`) после патча переписывает **одну** запись `checksums["vs/code/electron-browser/workbench/workbench.html"]` в `product.json` IDE: только если рядом есть `workbench.html.jelly-cursor-backup` или в файле есть блок `workstation-ui`, форматирование и остальные суммы не меняются. Проверено на копии IDE 2.6.0: предупреждения нет. Команда `installDomPatch` ждёт закрытия своего сообщения, поэтому Stability ждёт сам файл, а не команду. IDE хэширует файлы один раз за сессию, когда запуск завершён, то есть в момент активации расширений `onStartupFinished`. Поэтому Stability 1.3.22 ставит патч только через 60 секунд (`scheduleJellyPatch`), иначе проверка видит новый файл со старой суммой и предупреждение появляется в этой сессии. Jelly записывает свои настройки внутрь внедрённого скрипта, поэтому Stability 1.3.23 запоминает применённые настройки (`jellyCursor.appliedSettings` в globalState) и переустанавливает патч, когда они изменились.

### 3.12 Прочее
- `files.associations` (.jsx/.tsx/.env), `files.watcherExclude` (`.next`, `.turbo`, `coverage`, `dist`, `build`, `.cache`, `.git/objects`, `.git/subtree-cache` — без `**/node_modules/**`, чтобы TypeScript использовал нативный `--canUseWatchEvents`), `search.exclude` (`node_modules`, `.next`, `.turbo`, `coverage`, `dist`, `build`, `.git`), `typescript.preferences.includePackageJsonAutoImports: "auto"`, `oxc.lint.run: "onSave"` — быстрый IntelliSense и автоимпорт в Next.js, Node.js и React без 12-секундных задержек и без потери подсказок.
- `extensions.autoUpdate/autoCheckUpdates: true` — gallery-расширения обновляются сами; local VSIX (Aster, Stability) обновляет установщик по SHA-pin.
- `better-comments.tags`, `highlight-matching-tag.*`, `gutterpreview.*` — настройка соответствующих gallery-расширений.
- `calmTypeScript.*` — настройки собственного расширения Calm TypeScript (тихий режим, мягкий пульс печати (alpha ≤ 0.14), подсветка строки курсора на 0,3 с после ручного сохранения Ctrl+S — `savePulse`, автосохранение не мигает). Само расширение ничего не сохраняет: автосохранение 1 с делает IDE (`files.autoSave: afterDelay`), поэтому Format On Save не срабатывает во время набора.
- `window.menuBarVisibility: compact`, `workbench.editor.empty.hint: hidden` — минимализм UI.
- `workbench.editorAssociations: {*.vsix: default}` — VSIX открывается штатно (нужно для установки расширений из VSIX).

## 4. config/keybindings.json — каждая клавиша и почему

| Клавиша | Команда | Зачем |
|---|---|---|
| `tab` | `acceptSelectedSuggestion` | **Главный фикс**: когда меню подсказок открыто и сниппет выделен, Tab принимает его (раньше Tab перехватывал Emmet → `rfc` давал `<rfc></rfc>`). Guards обязательны: `suggestWidgetVisible && suggestWidgetHasFocusedSuggestion && !editorReadonly && !tabMovesFocus` — вне меню Tab ведёт себя как раньше (indent/Emmet). Этот binding дублируется в `extensions/workstation-stability/package.json` (обязан совпадать — тест следит) и применяется через helper во всех профилях. |
| `ctrl+alt+f` / `shift+alt+f` | `editor.action.formatDocument` | Форматирование одной клавишей: Prettier ставит отступы и стиль. Alt+Shift+F закреплён явно, чтобы другое расширение не перехватило его. `ctrl+shift+f` с 16.11.2026 снова «Поиск в файлах» IDE: обновление удаляет прежнюю managed-запись из keybindings.json (`RETIRED_KEYBINDINGS`), Stability 1.3.29 её больше не объявляет. |
| `ctrl+space` / `alt+space` | `editor.action.triggerSuggest` | Принудительное меню подсказок. |
| `ctrl+z` / `ctrl+y` / `ctrl+shift+z` | `undo` / `redo` | **Фикс `antigravity.inlineDiff.undo not found`**: срабатывает только при `antigravity.inlineDiffCanUndo` (или `CanRedo`) && `!antigravity.hasActiveDiff` && `config.antigravity.enableInlineDiff == false`, когда Antigravity 2.7.0 удаляет команду `inlineDiff.undo`, но забывает сбросить контекст. Нативный inline-diff при включённом режиме не перекрывается. |
| `ctrl+m`, `enter`, `shift+enter`, `ctrl+enter`, `m` → `-команда` | отключение голосовых команд Antigravity (`-antigravity.startVoiceRecording`, `-workbench.action.speech.*`) | Голосовой ввод срабатывал случайно при обычной печати (Ctrl+M/Enter) — отключён; `m` больше не останавливает запись. |

## 5. config/extensions.json — каталог 26 расширений

- `source: gallery` + `trackLatest: true` — ставится latest compatible через официальный CLI (без пинования версий — версия записывается после установки).
- `source: local-vsix` — собственные расширения с SHA-256 pin в `manifest.json`: `workstation.aster-appearance` (1.9.0, 11 палитр + 10 шрифтов + встроенные офлайн-скриншоты инструкции), `workstation.stability-helper` (1.4.0 — применяет профиль без пауз Extension Host, чинит known vendor issues через maintenance, защищает Undo от зависшего `antigravity.inlineDiffCanUndo`, возвращает интерфейсный блок после обновления IDE и добавляет необязательные команды `Configure AI API Key` / `Test AI Connection` через `SecretStorage`), `workstation.calm-typescript` (3.5.0), `workstation.git-branch-panel` (1.9.0 — Pull Requests, Local/Remote/Both удаление веток, подсказка commit по `Tab`, incoming/outgoing/upstream статус).
- Live Server (`ritwickdey.liveserver`), авто-импорт-провайдеры и `anteprimorac.html-end-tag-labels` **намеренно отсутствуют** — встроенный TypeScript владеет импортами, а закрывающие теги подсвечивает Highlight Matching Tag и переименовывает `editor.linkedEditing`.
- С 16.11.2026 добавлены Pretty TypeScript Errors, ESLint, Live Preview (`ms-vscode.live-server`) и Vitest; с 3.14.0 добавлены `Prisma.prisma` (схемы `schema.prisma` в Next.js/Node.js) и `redhat.vscode-yaml` (YAML + JSON Schema для Docker Compose, GitHub Actions, OpenAPI) — оба активируются только на своих типах файлов с нулевой нагрузкой на `.js/.ts/.tsx`.
- Каждый entry содержит описание и категорию; состав поддерживается тестами (`test-verified-extension-install`, `test-clean-extensions`).

## 6. Темы Aster Atelier — generated, руками не править

`extensions/aster-appearance/themes/<имя>.json` (22 файла) генерируются `scripts/build-aster.cjs` из `palettes.cjs`. Каждая палитра задаёт ~570 цветов: все ключи встроенных тем Default и все видимые части IDE (сайдбар, панели, вкладки, меню, виджеты, уведомления, терминал, diff, чат Antigravity) плюс правило для каждого синтаксиса базовой темы — ни один угол не остаётся «чужого» цвета. Список ключей IDE лежит в `scripts/aster-color-registry.json`; тест проверяет, что каждый ключ существует, покрывает базовую тему и что контраст текста ≥ 4.5. С 1.4.0 все темы окрашивают одни и те же 22 роли кода (одна карта TextMate-скоупов и semantic-токенов в `build-aster.cjs`), комментарии ≥ 5:1, ключевые роли заметно различаются (`tests/test-aster-themes.mjs`).

Палитры **не регистрируются** как темы IDE: встроенный выбор темы (кнопка «Задать цветовую тему», Ctrl+K Ctrl+T) меняет тему при наведении, и отключить это нельзя. Aster пишет цвета как theme-scoped `workbench.colorCustomizations` / `editor.tokenColorCustomizations` / `editor.semanticTokenColorCustomizations` для базы `Visual Studio Dark`/`Visual Studio Light` (не Default Modern — это тема самой Antigravity) и выбирает эту базу; имя палитры хранится в `asterAppearance.theme`. Тема меняется кликом по карточке в студии (сразу, без кнопки) или кликом/Enter в списке «Aster Atelier: Выбрать тему». С 1.2.0 палитры повторяют цвета популярных тем (One Dark Pro, Dracula, Tokyo Night, Catppuccin, GitHub, Night Owl… — источники в `extensions/aster-appearance/THEMES.md`); у каждой свои цвета ролей кода, тусклые цвета подняты до 4.6:1. Старые названия (`oceanic pro`, `nord polar`, `git hab light`, `ligth`…) при запуске сами переводятся на ближайшую новую палитру (`palettes.legacy`). Личные цвета для всех тем (`workbench.colorCustomizations` без скобок) по-прежнему имеют приоритет.

Шрифты: все 10 семейств (JetBrains Mono, Fira Code, Cascadia Code, Victor Mono, Monaspace Krypton Var, Iosevka, IBM Plex Mono — без лигатур, Geist Mono, Rec Mono Linear, Maple Mono) лежат в расширении; установщик (`ensureAsterFonts`) и само расширение при старте ставят недостающие для текущего пользователя из этих файлов — без скачивания, один раз на версию шрифта (запись `installed-fonts.json` в globalStorage). «Применить шрифт» включает проверенные OpenType features в `editor.fontLigatures`: для Monaspace также `ss01`–`ss10`. Шрифт, размер, толщина (кнопки − / + по реальным толщинам шрифта) и одно из 7 начертаний применяются вместе кнопкой «Применить шрифт»; начертание толщину не меняет, старые пресеты толщины (лёгкий…жирный курсив) при запуске переводятся в «Обычный»/«Курсив» + `editor.fontWeight`. Курсив реально включается для всего кода (одно собственное TextMate-правило + `italic` у semantic `*`, «Обычный» удаляет только их). Начертания по частям кода (с 1.7.0) добавляют свои правила: курсив комментариев и/или ключевых слов, жирные ключевые слова или жирные объявления (TextMate + semantic `*.declaration` `bold`); операторы `=>` `===` `&&` остаются прямыми, флаги `bold` снимаются только если их ставил Aster.

После правки palettes/build-aster: `node scripts/build-aster.cjs && node scripts/package-aster.cjs` — он обновит темы, `package.json`, VSIX и `manifest.json` (SHA-pin). Порядок версий должен соответствовать `config/extensions.json`. Прозрачные errorLens-ключи добавлены именно в build-aster (CI пересобирает темы и отбрасывает ручные правки JSON — это ловится тестом).

## 7. Хронология: какой баг каким решением закрыт

1. Жёлтые блоки подсказок Tailwind на всю строку → прозрачные `errorLens.*Background(+Light/Message/Range)` + Foreground alpha 26 (была причина: Light-варианты не были перекрыты).
2. Tab принимал Emmet вместо React-сниппета → keybinding `tab → acceptSelectedSuggestion` с узкими guards.
3. Шрифт применялся только к редактору → 10 font-family ключей (+ `editor.fontSize`, `window.zoomLevel` = 12 записей) в `applyToAllProfiles`; с 3.0.29 все 10 ключей заданы и в config, а `--apply-profile` не разводит шрифты редактора и терминала.
4. Шрифт не устанавливался (`UnauthorizedAccess`) → `install-font.ps1` вызывается только с `-ExecutionPolicy Bypass` (`font-service.cjs`, `lib/font.js`).
5. Тема менялась без клика (нативный preview-пикер) → с Aster 1.1.0 палитры не регистрируются как темы IDE, поэтому кнопки «Задать цветовую тему» больше нет; выбор — только клик по карточке в студии или клик/Enter в «Aster Atelier: Выбрать тему».
6. Новые managed-ключи не доходили до старых установок → фикс merge (объекты + union + починка мёртвого regex `\\[`); регрессия-тест обязателен.
7. Обновление Stability падало (ENOENT при backup `media/`) → `backupRegisteredHelper` создаёт подкаталоги.
8. Theme change на странице Studio без Apply → Apply/Cancel: просмотр не коммитит, Cancel возвращает.
9. Обычная установка падала на непроверенной версии IDE → native-preflight только для `--auto-approve`/`--quiet-completion`; каталог `config/native-compatibility.json`: 2.6.0 (исправлена мёртвая ссылка 404), 2.5.5, 2.5.2 (проверка встроенной схемы). Регрессия-тест: `test-installer-preflight.mjs`.
10. Цвета Calm TypeScript (11 ключей) расходились с config (27) → `QUIET_COLORS` = ровно управляемые ключи config, тест `test-calm-typescript.mjs` сверяет.
12. Turbo Console Log убран по запросу пользователя: нет в каталоге, 4 ключа `turboConsoleLog.*` удалены из config; у старых установок расширение архивируется в `~/.gemini/backups` (`RETIRED_EXTENSIONS` → `true`), а их `turboConsoleLog.*` удаляются из settings.json (`RETIRED_SETTING_PREFIXES`).
11. Старые папки Aster копились в профиле → после установки архивируются в `~/.gemini/backups` (`archiveStaleExtensionDirs`).
13. «Installation appears to be corrupt» в первой сессии после патча Jelly → патч через 60 секунд после запуска, после проверки целостности IDE (Stability 1.3.22).
14. Части IDE оставались цвета базовой темы, 20 палитр с дублями и опечатками в названиях → 17 палитр с полным покрытием (~570 цветов), имена исправлены, старые переводятся автоматически (Aster 1.1.0).
15. Код выглядел бесцветным: в 14 из 20 палитр переменные, `const`, свойства и параметры оставались цветом простого текста; три палитры повторяли другие (Monokai ≈ Dracula, Material Palenight ≈ Tokyo Night, Shades of Purple ≈ Cobalt2); Quiet Light и Solarized Dark рисовали код ниже 4.5:1 и делали функции/типы жирными при выбранном «Обычный» → 17 палитр без повторов (сохранённый выбор открывает двойника), имена получают рекомендованный VS Code цвет (Dark+ светло-голубой, Light+ тёмно-синий), текст от 7:1, в стандартных темах тусклые цвета поднимаются до 4.6:1, выбранный стиль действует во всех темах (Aster 1.3.0).
15. Шрифт требовал скачивания, «Font exists in the OS but is not available in this renderer», курсив только для предпросмотра → шрифты из расширения, кнопка «Применить шрифт», настоящий курсив (Aster 1.1.0).
16. Имя вкладки с ошибкой красилось в красный → `workbench.editor.decorations.colors/badges: false`.
17. Новые настройки Jelly не применялись к уже стоящему патчу → Stability 1.3.23 переустанавливает патч при их изменении.
18. Агент спрашивал разрешение на `npx shadcn@latest add dialog` и повторял команду через `Set-Location`/`cmd /c` → полный `permissions.allow`, `autoApprove {"/.*/": true}`, раздел Terminal в правилах (16.11.2026).
19. Stability Helper навсегда пропускал профиль после первого применения, даже когда настройки вернулись к значениям по умолчанию → 1.3.29 возвращает такие значения один раз за запрос; явные значения пользователя остаются.

## 8. Где код и как проверять

| Задача | Код | Проверка |
|---|---|---|
| Применение settings/keybindings | `lib/installer.js`, `lib/profile-settings.js` | `npm test`, `tests/test-install-modes.mjs`, `tests/test-personal-config-preservation.mjs` |
| Темы и шрифты (студия) | `extensions/aster-appearance/` | `node --test tests/test-aster-appearance.mjs`; live: `node tests/aster-editor.cjs` |
| Профиль/конфликты/восстановление | `extensions/workstation-stability/` | `npm run test:extension-settings`, `test:profile-keybindings` |
| Установка | `scripts/bootstrap.ps1`, `bin/workstation-setup.js` | `npm run test:bootstrap` (PS 5.1), `test:bootstrap:network` (pwsh 7, CI) |
| Шрифты ОС | `extensions/aster-appearance/font-service.cjs` | live-тест в CI (`ASTER_VERIFY_FONT_INSTALL=1`) |

## 9. Правила для ИИ/разработчика

1. Personal-ключи (§2) не перетирать значениями из `config/` — новые managed-ключи добавляются, старые личные значения остаются.
2. Темы и manifest — только через build-скрипты; версию Aster поднимать при любом изменении payload.
3. `errorLens.*`/шрифты менять **симметрично**: config/settings.json + build-aster.cjs (для тем) + тесты.
4. `chat.tools.terminal.autoApprove`, `permissions.allow` и `security.workspace.trust.*` — только по явному запросу пользователя (последний — 16.11.2026: полный набор).
5. Каждый фикс настроек сопровождай регрессия-тестом (примеры в test-stability, test-personal-config-preservation, test-install-modes) — без теста CI-регрессии неизбежны.
6. Прямой push в `main` разрешён; PR/force-push — нет.
