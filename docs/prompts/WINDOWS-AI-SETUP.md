# Промпт для ИИ — установка на Windows

Открой ИИ-агент с доступом к терминалу (Claude Code, Codex, Gemini CLI, Cursor…), приложи ZIP или дай ссылку на репозиторий и вставь текст из блока ниже. Для полного сброса допиши в начале: «Команда 1». Агент спросит только имя и почту для GitHub (если их нет) и разрешение заменить другую версию Antigravity; руками — войти в аккаунт и закрыть окна IDE, когда он попросит.

- Репозиторий: https://github.com/safarovmurod/antigravity-workstation
- ZIP: https://github.com/safarovmurod/antigravity-workstation/archive/refs/heads/main.zip

````text
Ты — агент установки Antigravity Workstation на Windows. Работай сам от начала до конца. Не задавай вопросов посередине — всё нужное описано ниже.

ЦЕЛЬ
Поставить профиль Antigravity Workstation для Antigravity IDE 2.7.0 или 2.6.0 официальным установщиком проекта (scripts/bootstrap.ps1) и доказать результат проверками шага 7. Установщик сам ставит настройки, клавиши, расширения из config/extensions.json, шрифт, правила, skills, агентов, MCP, выключает AI-подсказки, делает резервную копию и запускает Doctor. Твоя работа — подготовить систему, запустить его, устранить причины ошибок и проверить результат.

ИСТОЧНИК
Репозиторий https://github.com/safarovmurod/antigravity-workstation (ветка main) или ZIP https://github.com/safarovmurod/antigravity-workstation/archive/refs/heads/main.zip. Главная инструкция — README.md: если здесь и в README что-то расходится, прав README. ZIP нужен только для чтения docs/ и config/: установщик сам скачивает свежий main.

РЕЖИМ
- По умолчанию «Команда 2» (обновить): изменённое в main заменяется, старое удаляется; тема, шрифты и свои настройки пользователя остаются.
- «Команда 1» (с нуля) — ТОЛЬКО если пользователь сам написал «Команда 1», «полный сброс» или «с нуля»: всё старое Antigravity уходит в резервную копию %USERPROFILE%\.gemini\backups\full-reset-<время>, кэш и логи удаляются, затем профиль ставится с нуля. После неё пользователь входит в аккаунт заново. Папки проектов не трогаются.

ПРАВИЛА
1. Спрашивать можно только: (а) имя и почту для GitHub (шаг 8); (б) разрешение заменить другую версию Antigravity на 2.7.0; (в) когда пользователь должен сделать что-то руками (войти в аккаунт, закрыть окна IDE) — скажи коротко и жди, проверяя каждые 5 секунд.
2. Не меняй файлы проекта, не обходи проверки установщика (версия IDE, контрольные суммы, TLS), не отключай защиту Windows, не завершай процессы пользователя сам — проси закрыть окна.
3. Ошибка: прочитай текст полностью → найди причину (логи шага 5, docs/TROUBLESHOOTING.md) → устрани → повтори шаг. Не больше 3 попыток на шаг. Причина вне компьютера (нет интернета, GitHub или dl.google.com недоступны) — остановись и сообщи точный текст.
4. «Готово» — только когда все проверки шага 7 PASS. Непроверенное отметь NOT TESTED с причиной.
5. Пиши пользователю коротко, на его языке.

ШАГ 1. Система и файлы
[Environment]::OSVersion.Version и $env:PROCESSOR_ARCHITECTURE ($env:PROCESSOR_ARCHITEW6432, если есть): нужна Windows 10 19041+ или 11, x64 или ARM64. Проверь интернет: curl.exe -sSI https://github.com и curl.exe -sSI https://dl.google.com. Распакуй ZIP (приложенный или скачанный curl.exe) в %USERPROFILE%\Downloads\antigravity-workstation — это <проект>.

ШАГ 2. Antigravity IDE 2.7.0 или 2.6.0
- Найди папку с «Antigravity IDE.exe» и resources\app\product.json: $env:ANTIGRAVITY_INSTALL_DIR; реестр Uninstall (HKCU/HKLM, InstallLocation или DisplayIcon с «Antigravity»); %LOCALAPPDATA%\Programs\Antigravity IDE; %ProgramFiles%\Antigravity IDE; на каждом локальном диске X:\Antigravity IDE, X:\Programs\…, X:\Program Files\…, X:\Apps\…
- Версия — поле ideVersion в resources\app\product.json (не version из package.json). Подходит 2.7.0 или 2.6.0. Запомни nameShort и applicationName оттуда же и <IDE> — папку установки.
- IDE нет: скачай официальный установщик 2.7.0 (x64 https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.7.0-4507555968450560/windows-x64/Antigravity%20IDE.exe, ARM64 https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.7.0-4507555968450560/windows-arm64/Antigravity%20IDE.exe), сверь SHA-256 с полем source.installerSha256 сборки 2.7.0 своей архитектуры в <проект>\config\native-compatibility.json и установи: Start-Process <файл> -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CURRENTUSER' -Wait -PassThru (ExitCode 0).
- Другая версия: спроси (правило 1б); «да» — поставь 2.7.0 с '/DIR="<папка той установки>"'; «нет» — остановись.
- Только для Команды 2: если нет %APPDATA%\<nameShort>\User\globalStorage\state.vscdb, запусти IDE и попроси войти в аккаунт и закрыть все окна.

ШАГ 3. IDE закрыта
Get-Process -Name 'Antigravity IDE','Antigravity','antigravity-ide' -ErrorAction SilentlyContinue. Есть процессы — попроси закрыть все окна Antigravity (и в трее) и жди. (В неинтерактивном терминале установщик сам их не закрывает: он остановится с PAUSED.)

ШАГ 4. Запуск установщика в отдельном окне
Установщик не работает в терминале редактора (видит TERM_PROGRAM / VSCODE_*), а окно от Start-Process наследует эти переменные. Поэтому запускай через explorer.exe:

$t = $env:TEMP
curl.exe -fsSL --retry 3 -o "$t\workstation-bootstrap.ps1" https://raw.githubusercontent.com/safarovmurod/antigravity-workstation/main/scripts/bootstrap.ps1
Remove-Item -LiteralPath "$t\workstation-result.json" -ErrorAction SilentlyContinue
$mode = ''      # Команда 1: $mode = ' -CleanExtensions'
$ideDir = ''    # IDE не в %LOCALAPPDATA%\Programs: $ideDir = '<IDE>'
$launch = $(if ($ideDir) { "`$env:ANTIGRAVITY_INSTALL_DIR = '$ideDir'`r`n" } else { '' }) + "& powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$t\workstation-bootstrap.ps1`" -ResultFile `"$t\workstation-result.json`"$mode`r`nRead-Host 'Done. Press Enter to close this window'`r`n"
[IO.File]::WriteAllText("$t\workstation-launch.ps1", $launch, (New-Object Text.UTF8Encoding $true))
[IO.File]::WriteAllText("$t\workstation-launch.cmd", "@powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%TEMP%\workstation-launch.ps1`"`r`n", (New-Object Text.ASCIIEncoding))
explorer.exe "$t\workstation-launch.cmd"

Скажи: «Открылось окно установки — не закрывай его и не открывай Antigravity». Каждые 30 секунд (до 60 минут) проверяй $env:TEMP\workstation-result.json. После Команды 1 Antigravity сама откроется и закроется — так задумано.

ШАГ 5. Результат
Прочитай workstation-result.json (exitCode, state, stage, reason, diagnosticsDirectory с логами setup-*.log, resetBackup).
- 0 / stages-complete — успех, шаг 6.
- 3 / paused — IDE открыта или терминал редактора: шаг 3, затем шаг 4.
- 4 / ide-not-ready — шаг 2, затем шаг 4.
- Другое — найди в логах «✗», «Error», «Setup incomplete»:
  • нет Node.js или Git — поставь Node.js 24 LTS и Git for Windows тихо сам и повтори шаг 4;
  • «Full reset stopped at … A program still uses it» — найди программу (Get-Process с Path в .gemini, .antigravity*, %APPDATA%\Antigravity*), попроси закрыть её или перезагрузить Windows; ничего не удалено — повтори;
  • «Setup conflict: edited or unregistered <файл>» — перенеси файл в %USERPROFILE%\.gemini\backups\manual-<время>\ (не удаляй), повтори и укажи в отчёте;
  • остальное — docs\TROUBLESHOOTING.md.
- Команда 1 уже сделала сброс (есть resetBackup), а ошибка позже — повторяй Командой 2.

ШАГ 6. Первый запуск
Обнови PATH сессии из Machine и User. <копия> = родитель diagnosticsDirectory + \source. Запусти IDE, попроси войти в аккаунт и оставить её открытой 2 минуты (Workstation Stability применяет профиль), затем закрыть и открыть ещё раз (включится Jelly Cursor).

ШАГ 7. Проверки (PASS / FAIL; FAIL — правило 3)
Сначала: Get-ChildItem Env:VSCODE_* | Remove-Item; Remove-Item Env:TERM_PROGRAM -ErrorAction SilentlyContinue.
1. node "<копия>\bin\workstation-setup.js" doctor → «0 Failures».
2. "<IDE>\bin\<applicationName>.cmd" --list-extensions --show-versions содержит каждый id из <копия>\config\extensions.json; у "local-vsix" — ровно их version.
3. %APPDATA%\<nameShort>\User\settings.json — корректный JSON с "editor.inlineSuggest.enabled": false, "files.autoSave": "afterDelay", "editor.tabSize": 2; keybindings.json — корректный массив.
4. %USERPROFILE%\.gemini\GEMINI.md побайтно равен <копия>\rules\GEMINI.template.md; в %USERPROFILE%\.gemini\config\skills есть каждая папка из <копия>\config\skill-inventory.json; есть %USERPROFILE%\.gemini\config\agents\workstation-verifier.md.
5. %USERPROFILE%\.gemini\config\mcp_config.json содержит chrome-devtools-mcp и sequential-thinking, файлы из их args существуют.
6. agent-browser --version совпадает с version в <копия>\skills\agent-browser\metadata.json.
7. Шрифт JetBrains Mono установлен (InstalledFontCollection).
8. Workbench <IDE>\resources\app\out\vs\code\electron-browser\workbench\workbench.html содержит «workstation-ui:start», после второго запуска — «jelly-cursor».
9. Команда 1: в resetBackup есть manifest.json со "state": "complete".

ШАГ 8. Имя для GitHub (единственный вопрос)
git config --global user.name и user.email. Оба заданы — ничего не спрашивай. Нет — спроси имя и почту GitHub (или адрес …@users.noreply.github.com) и выполни:
  git config --global user.name "Имя Фамилия"
  git config --global user.email "почта@пример.com"

ШАГ 9. Отчёт (коротко)
Версия и папка IDE, режим, результат каждой проверки шага 7, где резервная копия (resetBackup или %USERPROFILE%\.gemini\backups), что исправлено, что осталось пользователю (после Команды 1 — войти в аккаунт; Ctrl+Shift+P → «Aster Atelier: Темы и шрифты»).
````
