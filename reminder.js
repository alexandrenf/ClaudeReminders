/**
 * reminder.js — drop-in replacement for worker.js
 *
 * Adds a lightweight HTTP server alongside the existing calendar polling logic:
 *   GET  /health  → 200 { status: "ok", uptime: <seconds> }   (no auth)
 *   POST /notify  → sends a Pushover notification directly     (requires Bearer NOTIFY_TOKEN)
 *
 * Fly.io setup:
 *   1. Change your Dockerfile CMD to: node reminder.js
 *   2. Add [http_service] to fly.toml (internal_port = 8080)
 *   3. fly secrets set NOTIFY_TOKEN=<same value as CLAUDEREMINDERS_NOTIFY_TOKEN on mochi-mcp>
 */

"use strict";

const http = require("http");
const { google } = require("googleapis");
const fetch = require("node-fetch");

// ── Config from env vars ──────────────────────────────────────────────────────
const CALENDAR_ID = process.env.CALENDAR_ID;
const PUSHOVER_USER = process.env.PUSHOVER_USER;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const NOTIFY_TOKEN = process.env.NOTIFY_TOKEN; // shared secret with mochi-mcp
const PORT = parseInt(process.env.PORT ?? "8080", 10);
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const FIRE_WINDOW_MS = 2 * 60 * 1000;   // notify if event starts within 2 min

// ── Env validation ────────────────────────────────────────────────────────────
function validateEnv() {
  const required = [
    "CALENDAR_ID",
    "PUSHOVER_USER",
    "PUSHOVER_TOKEN",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "NOTIFY_TOKEN",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing required env vars:", missing.join(", "));
    process.exit(1);
  }
}

// ── Google Auth ───────────────────────────────────────────────────────────────
function getCalendarClient() {
  const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
  return google.calendar({ version: "v3", auth });
}

// ── State ─────────────────────────────────────────────────────────────────────
const firedEvents = new Set();
const startedAt = Date.now();

// ── Pushover ──────────────────────────────────────────────────────────────────
async function sendPushover(title, message) {
  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: PUSHOVER_TOKEN,
      user: PUSHOVER_USER,
      title: `🔔 ${title}`,
      message: message || "No description.",
      sound: "magic",
    }),
  });
  const data = await res.json();
  if (data.status !== 1) {
    console.error("Pushover error:", data);
    throw new Error(`Pushover rejected: ${JSON.stringify(data)}`);
  }
  console.log(`[${new Date().toISOString()}] Notification sent: "${title}"`);
}

// ── Calendar polling ──────────────────────────────────────────────────────────
async function poll() {
  try {
    const calendar = getCalendarClient();
    const now = new Date();
    const windowEnd = new Date(now.getTime() + FIRE_WINDOW_MS);

    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: windowEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = res.data.items || [];
    for (const event of events) {
      if (firedEvents.has(event.id)) continue;
      firedEvents.add(event.id);
      await sendPushover(event.summary || "Reminder", event.description || "");
    }

    if (firedEvents.size > 500) firedEvents.clear();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Poll error:`, err.message);
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

const httpServer = http.createServer(async (req, res) => {
  // GET /health — no auth required
  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { status: "ok", uptime: Math.floor((Date.now() - startedAt) / 1000) });
    return;
  }

  // POST /notify — requires Bearer NOTIFY_TOKEN
  if (req.method === "POST" && req.url === "/notify") {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${NOTIFY_TOKEN}`) {
      send(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      const { title, message } = await readBody(req);
      if (!title) { send(res, 400, { error: "title is required" }); return; }
      await sendPushover(title, message ?? "");
      send(res, 200, { status: "sent" });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] /notify error:`, e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  send(res, 404, { error: "Not found" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
validateEnv();

httpServer.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] HTTP server listening on port ${PORT}`);
});

console.log(`[${new Date().toISOString()}] Worker started. Polling every ${POLL_INTERVAL_MS / 1000}s`);
poll();
setInterval(poll, POLL_INTERVAL_MS);
