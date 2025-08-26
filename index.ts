// Cloudflare Worker (TypeScript) - Telegram WebApp backend
// Routes:
//  - GET /api/history?initData=...  -> returns merged history for chat (requires verifying initData signature)
//  - POST /telegram/webhook         -> Telegram webhook for incoming messages (text / web_app_data)
//  - GET /frontend/                 -> serves the static frontend (for convenience, but recommended to host frontend on Pages)

import { Router } from "itty-router"; // tiny router shim - we'll implement a micro-router without external deps
// NOTE: we do not actually import external libs to keep bundle minimal.

declare const BOT_TOKEN: string; // provided via wrangler secret or env
declare const DB: D1Database;    // D1 binding

// ---- Utilities ----
function hex(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(message: string) {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  return hex(hashBuffer);
}

async function hmacSha256(keyBytes: Uint8Array, data: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return hex(sig);
}

// Parse querystring-like initData into map
function parseInitData(initData: string) {
  const params = new URLSearchParams(initData);
  const obj: Record<string, string> = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

// Verify WebApp initData signature per Telegram docs
async function checkWebAppSignature(token: string, initData: string) {
  try {
    const params = parseInitData(initData);
    if (!params["hash"]) return false;
    const receivedHash = params["hash"];
    delete params["hash"];
    const entries = Object.keys(params).sort().map(k => `${k}=${params[k]}`);
    const data_check_string = entries.join("\n");
    // secret_key = sha256("WebAppData" + token)
    const secret_hex = await sha256("WebAppData" + token);
    // secret_hex is hex string; convert to bytes
    const keyBytes = new Uint8Array(secret_hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const computed = await hmacSha256(keyBytes, data_check_string);
    return computed === receivedHash;
  } catch (e) {
    return false;
  }
}

// Simple helper to run D1 queries
async function runAll(sql: string, binds: any[] = []) {
  const res = await DB.prepare(sql).bind(...binds).all();
  return res.results || [];
}
async function runExec(sql: string, binds: any[] = []) {
  await DB.prepare(sql).bind(...binds).run();
}

// Split into chunks <= limit characters
function splitIntoChunks(text: string, limit = 3900) {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += limit) parts.push(text.slice(i, i + limit));
  return parts;
}

// Merge consecutive bot chunks that belong to same group (server-side safety)
function mergeChunks(rows: any[]) {
  const result: any[] = [];
  let buffer: string[] = [];
  let lastRole: string | null = null;
  let currentGroup: number | null = null;
  for (const r of rows) {
    if (r.role === "user") {
      if (buffer.length) {
        result.push({ role: "bot", content: buffer.join(""), created_at: buffer[buffer.length-1]?.created_at || new Date().toISOString() });
        buffer = [];
      }
      result.push(r);
      lastRole = "user";
      currentGroup = r.group_id;
    } else {
      // bot
      if (lastRole === "user" || currentGroup !== r.group_id) {
        // start new buffer
        if (buffer.length) {
          result.push({ role: "bot", content: buffer.join(""), created_at: r.created_at });
          buffer = [];
        }
        buffer.push(r.content);
      } else {
        buffer.push(r.content);
      }
      lastRole = "bot";
      currentGroup = r.group_id;
    }
  }
  if (buffer.length) result.push({ role: "bot", content: buffer.join(""), created_at: new Date().toISOString() });
  return result;
}

// ---- Router (very small) ----
const router = Router(); // type-only; we'll use simple switch below

addEventListener("fetch", (event: FetchEvent) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request: Request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  try {
    if (request.method === "GET" && pathname === "/api/history") return await handleHistory(request);
    if (request.method === "POST" && pathname === "/telegram/webhook") return await handleWebhook(request);
    if (request.method === "GET" && pathname.startsWith("/frontend/")) return await serveFrontend(request);
    return new Response("Not found", { status: 404 });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// Serve static frontend (convenience; for production host on Pages)
async function serveFrontend(request: Request) {
  // load from __STATIC_CONTENT_MANIFEST__ or embed simple page
  const index = await fetch("https://example.com/404.html").catch(()=>null);
  const html = `<!doctype html><html><body><h1>Deploy frontend on Pages and set WEBAPP URL in BotFather</h1></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// GET /api/history?initData=...
async function handleHistory(request: Request) {
  const url = new URL(request.url);
  const initData = url.searchParams.get("initData") || "";
  if (!initData) return new Response(JSON.stringify({ error: "initData required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const ok = await checkWebAppSignature(BOT_TOKEN, initData);
  if (!ok) return new Response(JSON.stringify({ error: "Bad signature" }), { status: 401, headers: { "Content-Type": "application/json" } });
  // parse user id from initData
  const params = Object.fromEntries(new URLSearchParams(initData));
  const userJson = params["user"] ? JSON.parse(params["user"]) : null;
  const chatId = userJson?.id ? String(userJson.id) : (params["chat_instance"] || "");
  if (!chatId) return new Response(JSON.stringify({ error: "chat_id missing" }), { status: 400, headers: { "Content-Type": "application/json" } });

  const rows = await runAll("SELECT role, content, group_id, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC", [chatId]);
  const merged = mergeChunks(rows);
  return new Response(JSON.stringify({ messages: merged }), { headers: { "Content-Type": "application/json" } });
}

// POST /telegram/webhook
async function handleWebhook(request: Request) {
  if (!BOT_TOKEN) return new Response(JSON.stringify({ ok: true, skipped: "no token" }), { headers: { "Content-Type": "application/json" } });
  const payload = await request.json().catch(()=>null);
  if (!payload) return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  const message = payload.message || payload.edited_message;
  if (!message) return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });

  const chatId = String(message.chat.id);
  let text: string | null = null;
  if (message.web_app_data && message.web_app_data.data) {
    try {
      const parsed = JSON.parse(message.web_app_data.data);
      if (parsed?.type === "user_message") text = parsed.text;
      else text = message.web_app_data.data;
    } catch (e) {
      text = message.web_app_data.data;
    }
  } else {
    text = message.text || null;
  }
  if (!text) return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });

  // determine next group_id (max + 1)
  const last = await runAll("SELECT MAX(group_id) as mg FROM messages WHERE chat_id = ?", [chatId]);
  const nextGroup = (last[0] && last[0].mg) ? (Number(last[0].mg) + 1) : 1;

  // save user message
  await runExec("INSERT INTO messages (chat_id, role, content, group_id, created_at) VALUES (?, ?, ?, ?, ?)", [chatId, "user", text, nextGroup, new Date().toISOString()]);

  // call LLM or produce echo demo
  // If you want to call a public LLM endpoint, you can set BOT's environment or use fetch to your LLM.
  const demoAnswer = `Эхо от LLM. Ты сказал:\\n\\n${text}\\n\\n` + "Длинный текст. ".repeat(300);

  const chunks = splitIntoChunks(demoAnswer, 3900);

  for (const chunk of chunks) {
    // send to telegram
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "Markdown" })
      });
    } catch (e) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk })
      });
    }
    // save chunk
    await runExec("INSERT INTO messages (chat_id, role, content, group_id, created_at) VALUES (?, ?, ?, ?, ?)", [chatId, "bot", chunk, nextGroup, new Date().toISOString()]);
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
