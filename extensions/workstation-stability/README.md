# Workstation Stability

![Workstation Stability](icon.png)

Служебное расширение профиля [Antigravity Workstation](https://github.com/m-safarov/antigravity-workstation#quick-start): применяет управляемый профиль редактора с сохранением личных настроек, защищает Undo/Redo в Antigravity 2.7.0–2.9.0+, управляет безопасным обновлением gallery-расширений и предоставляет опциональную локальную ИИ-помощь с хранением ключа в IDE `SecretStorage` или личном `%USERPROFILE%\.gemini\config\workstation-setup\.env` вне Git.

## Опциональная локальная ИИ-помощь (1.4.3)

Все базовые функции установки, редактора и Git работают полностью без ИИ (`workstationStability.ai.enabled: false` по умолчанию).

Подсказки сообщений commit по `Tab` в Git Branch Panel работают для всех пользователей сразу из коробки:

1. **Личный ключ (приоритет 1 — IDE `SecretStorage` или `~/.gemini/config/workstation-setup/.env`):** нажмите **`Ctrl + Shift + P`** → **`Workstation: Configure AI API Key`** или создайте `%USERPROFILE%\.gemini\config\workstation-setup\.env` (`WORKSTATION_AI_API_KEY=<ваш_ключ>`).
2. **Общий серверный прокси по умолчанию (приоритет 2 — `workstationStability.ai.proxyUrl`):** по умолчанию подключён защищённый Cloudflare Worker (`https://workstation-commit-ai.safarovmancho.workers.dev/suggest`, исходники в `services/commit-ai-proxy/`), где upstream API-ключ хранится строго зашифрованным на сервере Cloudflare. Чтобы отключить прокси, задайте `workstationStability.ai.proxyUrl: ""` или `workstationStability.ai.enabled: false`.
3. **Встроенный офлайн diff-анализатор (приоритет 3):** работает без интернета и без API-ключа, читая реальные изменения `git diff`.
4. Настройте провайдер, endpoint и модель отдельно в Settings (`workstationStability.ai.provider`, `workstationStability.ai.endpoint`, `workstationStability.ai.model` — по умолчанию `gemini-3.5-flash-lite`, `workstationStability.ai.proxyUrl`, `workstationStability.ai.enabled`).
5. Проверьте подключение: **`Ctrl + Shift + P`** → **`Workstation: Test AI Connection`** — команда делает минимальный запрос (через личный ключ или `proxyUrl`) и показывает короткий redacted-результат.

Процессы терминала вне IDE не имеют доступа к `SecretStorage` расширения и используют детерминированное восстановление без записи ключей в репозиторий.

## Чистый редактор и производительность (1.4.3)

- Расширение `anteprimorac.html-end-tag-labels` выведено из состава профиля (убраны серые подписи Tailwind-классов вроде `/.flex.items-center...` после закрывающих JSX/TSX тегов); при этом полностью сохранены Tailwind CSS IntelliSense, Highlight Matching Tag и встроенный `editor.linkedEditing`.
- `reactSnippets.settings.importReactOnTop` выключен; новые `rfc/rafce` не добавляют лишний `import React`.
- `inline-diff-guard.cjs` защищает `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` при баге `antigravity.inlineDiff.undo` в Antigravity 2.7.0–2.9.0+.
- `profile.cjs`, `workbench-ui.cjs`, `jelly-patch.cjs` и `repair-chat.cjs` оптимизированы без холостого опроса диска и лишних проходов по языкам.

## Другие команды

- **`Workstation: Apply and Check Editor Settings`** — проверить и применить управляемые настройки (тема, шрифты и личные значения сохраняются; принудительный сброс требует явного подтверждения).
- **`Workstation: Inspect Project Setting Conflicts (Read Only)`** — посмотреть, где настройки проекта отличаются от профиля.
- **`Workstation: Check Antigravity Stability`** / **`Restore Known Extension Fixes`** — диагностика и восстановление известных исправлений расширений.
- **`Workstation: Reconnect MCP (Reload Window)`** — переподключение MCP-серверов.
- **`Workstation: Вопросы задачи (галочки и свой вариант)`** — удобный выбор ответов на вопросы из чата с копированием в буфер обмена.

Логи: **View → Output → Workstation Antigravity Stability**.
