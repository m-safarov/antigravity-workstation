# Workstation Stability

![Workstation Stability](icon.png)

Служебное расширение профиля [Antigravity Workstation](https://github.com/m-safarov/antigravity-workstation#quick-start): применяет управляемый профиль редактора с сохранением личных настроек, защищает Undo/Redo в Antigravity 2.7.0/2.8.0, управляет безопасным обновлением gallery-расширений и предоставляет опциональную локальную ИИ-помощь с хранением ключа в IDE `SecretStorage`.

## Опциональная локальная ИИ-помощь (1.4.0)

Все базовые функции установки, редактора и Git работают полностью без ИИ (`workstationStability.ai.enabled: false` по умолчанию).

Если вы хотите включить ИИ-помощь (восстановление после ошибок установки по строгому allowlist и подсказки сообщений commit в Git Branch Panel):

1. Нажмите **`Ctrl + Shift + P`** → **`Workstation: Configure AI API Key`**.
2. Вставьте личный ключ в скрытое (masked) поле — он сохраняется **только** в `SecretStorage` IDE (поддерживаются замена, очистка и безопасная отмена `Esc` с сохранением текущего ключа; пример-плейсхолдер из README автоматически считается пустым).
3. Настройте провайдер, endpoint и модель отдельно в Settings (`workstationStability.ai.provider`, `workstationStability.ai.endpoint`, `workstationStability.ai.model`, `workstationStability.ai.enabled`).
4. Проверьте подключение: **`Ctrl + Shift + P`** → **`Workstation: Test AI Connection`** — команда делает минимальный аутентифицированный запрос и показывает короткий redacted-результат (отсутствующий ключ, отклонённый ключ, недоступная модель или сбой сети).

Процессы терминала вне IDE не имеют доступа к `SecretStorage` расширения и используют детерминированное восстановление без записи ключей на диск.

## Чистый редактор и производительность (1.4.0)

- Расширение `anteprimorac.html-end-tag-labels` выведено из состава профиля (убраны серые подписи Tailwind-классов вроде `/.flex.items-center...` после закрывающих JSX/TSX тегов); при этом полностью сохранены Tailwind CSS IntelliSense, Highlight Matching Tag и встроенный `editor.linkedEditing`.
- `reactSnippets.settings.importReactOnTop` выключен; новые `rfc/rafce` не добавляют лишний `import React`.
- `inline-diff-guard.cjs` защищает `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` при баге `antigravity.inlineDiff.undo` в Antigravity 2.7.0/2.8.0.
- `profile.cjs`, `workbench-ui.cjs`, `jelly-patch.cjs` и `repair-chat.cjs` оптимизированы без холостого опроса диска и лишних проходов по языкам.

## Другие команды

- **`Workstation: Apply and Check Editor Settings`** — проверить и применить управляемые настройки (тема, шрифты и личные значения сохраняются; принудительный сброс требует явного подтверждения).
- **`Workstation: Inspect Project Setting Conflicts (Read Only)`** — посмотреть, где настройки проекта отличаются от профиля.
- **`Workstation: Check Antigravity Stability`** / **`Restore Known Extension Fixes`** — диагностика и восстановление известных исправлений расширений.
- **`Workstation: Reconnect MCP (Reload Window)`** — переподключение MCP-серверов.
- **`Workstation: Вопросы задачи (галочки и свой вариант)`** — удобный выбор ответов на вопросы из чата с копированием в буфер обмена.

Логи: **View → Output → Workstation Antigravity Stability**.
