
# Cloudflare Telegram LLM WebApp (Worker + Pages)

Этот проект - полностью рабочий Cloudflare-ориентированный прототип Telegram WebApp, включающий Cloudflare Worker (TypeScript) для backend'а и статический frontend (WebApp).

## Что внутри
- `worker/` - Cloudflare Worker (TypeScript)
  - `src/index.ts` - основной код
  - `package.json`, `tsconfig.json`, скрипты сборки
- `frontend/` - статическая страница WebApp (можно хостить на Cloudflare Pages)
- `wrangler.toml` - конфигурация wrangler

## Как развернуть (overview)
1. Установи Wrangler и esbuild:
   ```bash
   npm i -g wrangler
   cd worker
   npm ci
   ```
2. Создай D1-базу (через wrangler или Dashboard) и привяжи её в `wrangler.toml` или Dashboard.
   ```bash
   wrangler d1 create messages
   wrangler d1 execute messages --command "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, role TEXT, content TEXT, group_id INTEGER, created_at TEXT)"
   ```
3. Установи секрет BOT_TOKEN:
   ```bash
   wrangler secret put BOT_TOKEN
   ```
4. Построй и задеплой Worker:
   ```bash
   npm run build
   wrangler publish
   ```
   После этого у тебя будет URL типа `https://<your-worker>.workers.dev/telegram/webhook`
5. Настрой webhook для Telegram:
   ```bash
   curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" -d "url=https://<your-worker>.workers.dev/telegram/webhook"
   ```
6. Размести `frontend/` на Cloudflare Pages и укажи URL WebApp в BotFather:
   - `/setdomain` -> домен Pages (например `yourname.pages.dev`)
   - `/setmenubutton` -> URL: `https://yourname.pages.dev/index.html` (или `/frontend/` if you host as subpath)

## Примечания
- Worker в этом репозитории использует демонстрационный эхо-ответ LLM.   Чтобы подключить реальную LLM, замените `demoAnswer` в `src/index.ts` на `fetch` к вашему LLM endpoint.
- WebApp initData проверяется по подписи внутри Worker (HMAC-SHA256), поэтому WebApp должен передавать `initData` в `/api/history`.
- История сообщений хранится в D1, чанки отвечающих сообщений сохраняются с `group_id`, а API `/api/history` склеивает их в единые ответы между сообщениями пользователя.
