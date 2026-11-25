# Workstation Commit AI Proxy (Cloudflare Workers / Vercel)

Безопасный серверный прокси, который позволяет **всем пользователям** `antigravity-workstation` получать реальные AI-подсказки сообщений commit по `Tab` (`gemini-3.5-flash-lite`), пока ваш `GEMINI_API_KEY` остаётся **строго зашифрованным на сервере** (никогда не попадает в GitHub, `.vsix` или на компьютеры пользователей).

## Встроенная защита ключа и квоты

- `GEMINI_API_KEY` хранится только в зашифрованных **Server Secrets** Cloudflare/Vercel и никогда не возвращается в ответах или логах ошибок.
- Системный промпт жёстко зафиксирован на сервере только под короткий conventional commit (`<= 72` символа, `maxOutputTokens <= 64`) — прокси нельзя использовать как обычный чат-бот.
- Ограничение размера тела (`<= 14 KB`), серверная очистка секретов из diff и per-IP rate limit (`20 запросов/мин` по умолчанию).

## Способ 1: Cloudflare Workers (рекомендуется — бесплатно до 100 000 запросов/день)

Из папки `services/commit-ai-proxy`:

```powershell
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

После `deploy` вы получите публичный HTTPS-адрес вида:

```text
https://workstation-commit-ai.<ваш-поддомен>.workers.dev/suggest
```

Проверка работы: откройте `https://workstation-commit-ai.<ваш-поддомен>.workers.dev/health` — ответ должен содержать `"ok": true, "configured": true`.

## Способ 2: Vercel (бесплатно)

1. Импортируйте папку `services/commit-ai-proxy` в Vercel (или выполните `npx vercel` внутри этой папки).
2. В **Project Settings → Environment Variables** добавьте `GEMINI_API_KEY` (Secret) и при желании `GEMINI_MODEL=gemini-3.5-flash-lite`.
3. После деплоя используйте URL `https://<ваш-проект>.vercel.app/suggest`.

## Подключение к `antigravity-workstation`

- **Для себя / команды:** укажите URL в настройке IDE `workstationStability.ai.proxyUrl`.
- **Для всех пользователей репозитория по умолчанию:** пропишите этот **публичный URL прокси** (не ключ!) в `DEFAULT_PROXY_URL` файла `extensions/workstation-stability/ai-assistant.cjs` и пересоберите `workstation-stability` (`npm run build:stability`).
- Приоритет в Git Branch Panel:
  1. Личный ключ пользователя (IDE `SecretStorage` или `~/.gemini/config/workstation-setup/.env`), если задан;
  2. Серверный прокси `workstationStability.ai.proxyUrl`, если задан;
  3. Встроенный офлайн diff-анализатор (`commit-suggest.js`) без интернета и без ключа.
