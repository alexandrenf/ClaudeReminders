/**
 * reminder.js — drop-in replacement for worker.js
 *
 * Adds a lightweight HTTP server alongside the existing calendar polling logic:
 *   GET  /health  → 200 { status: "ok", uptime: <seconds> }   (no auth, used by Fly.io)
 *   GET  /status  → HTML health page with calendar check       (requires Bearer NOTIFY_TOKEN, for UptimeRobot)
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

// ── Config from env vars ──────────────────────────────────────────────────────
const CALENDAR_ID = process.env.CALENDAR_ID;
const PUSHOVER_USER = process.env.PUSHOVER_USER;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const NOTIFY_TOKEN = process.env.NOTIFY_TOKEN; // shared secret with mochi-mcp
const PORT = parseInt(process.env.PORT ?? "8080", 10);
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const FIRE_WINDOW_MS = 2 * 60 * 1000;   // notify if event starts within 2 min
const LOOKBACK_BUFFER_MS = 30 * 1000;
const LATE_EVENT_GRACE_MS = POLL_INTERVAL_MS;
const FIRED_EVENT_RETENTION_MS = FIRE_WINDOW_MS + POLL_INTERVAL_MS + LOOKBACK_BUFFER_MS;
const STALE_POLL_THRESHOLD_MS = 2 * POLL_INTERVAL_MS + LOOKBACK_BUFFER_MS;

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

// ── Google Auth (singleton) ────────────────────────────────────────────────────
let _calendar;
function getCalendarClient() {
  if (_calendar) return _calendar;
  const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
  _calendar = google.calendar({ version: "v3", auth });
  return _calendar;
}

// ── State ─────────────────────────────────────────────────────────────────────
const firedEvents = new Map();
const startedAt = Date.now();
let lastCheckedAt = startedAt;
const pollState = {
  isPolling: false,
  lastPollStartedAt: null,
  lastPollCompletedAt: null,
  lastSuccessfulPollAt: null,
  lastPollStatus: "starting",
  lastPollError: null,
  lastEventCount: 0,
  lastNotificationCount: 0,
  lastNotificationFailureCount: 0,
  lastWindowStartAt: null,
  lastWindowEndAt: null,
};

function pruneFiredEvents(nowMs) {
  const cutoff = nowMs - FIRED_EVENT_RETENTION_MS;
  for (const [key, ts] of firedEvents) {
    if (ts < cutoff) firedEvents.delete(key);
  }
}

function getEventStartValue(event) {
  return event.start?.dateTime ?? event.start?.date ?? event.originalStartTime?.dateTime ?? event.originalStartTime?.date ?? null;
}

function getEventStartMs(event) {
  const value = getEventStartValue(event);
  if (!value) return null;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function getEventNotificationKey(event) {
  return `${event.id}:${getEventStartValue(event) ?? "unknown"}`;
}

function toIsoOrNull(timestampMs) {
  return timestampMs === null ? null : new Date(timestampMs).toISOString();
}

async function listCalendarEvents(calendar, timeMin, timeMax) {
  const items = [];
  let pageToken;

  do {
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
      fields: "items(id,summary,description,start,originalStartTime),nextPageToken",
    });

    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return items;
}

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
  const pollStartedAt = Date.now();
  const windowStartMs = Math.max(startedAt, lastCheckedAt - LOOKBACK_BUFFER_MS);
  const windowEndMs = pollStartedAt + FIRE_WINDOW_MS;
  let notificationCount = 0;
  let notificationFailureCount = 0;

  pollState.isPolling = true;
  pollState.lastPollStartedAt = pollStartedAt;
  pollState.lastWindowStartAt = windowStartMs;
  pollState.lastWindowEndAt = windowEndMs;
  pollState.lastPollError = null;

  try {
    const calendar = getCalendarClient();
    const events = await listCalendarEvents(
      calendar,
      new Date(windowStartMs).toISOString(),
      new Date(windowEndMs).toISOString(),
    );

    for (const event of events) {
      const eventStartMs = getEventStartMs(event);
      if (eventStartMs !== null && eventStartMs < pollStartedAt - LATE_EVENT_GRACE_MS) continue;

      const eventKey = getEventNotificationKey(event);
      if (firedEvents.has(eventKey)) continue;

      firedEvents.set(eventKey, pollStartedAt);

      try {
        await sendPushover(event.summary || "Reminder", event.description || "");
        notificationCount += 1;
      } catch (err) {
        firedEvents.delete(eventKey);
        notificationFailureCount += 1;
        console.error(`[${new Date().toISOString()}] Notification error for event ${event.id}:`, err.message);
      }
    }

    lastCheckedAt = pollStartedAt;
    pruneFiredEvents(pollStartedAt);
    pollState.lastPollCompletedAt = Date.now();
    pollState.lastSuccessfulPollAt = pollState.lastPollCompletedAt;
    pollState.lastPollStatus = notificationFailureCount > 0 ? "degraded" : "ok";
    pollState.lastPollError = notificationFailureCount > 0
      ? `${notificationFailureCount} notification(s) failed during the last poll`
      : null;
    pollState.lastEventCount = events.length;
    pollState.lastNotificationCount = notificationCount;
    pollState.lastNotificationFailureCount = notificationFailureCount;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Poll error:`, err.message);
    pruneFiredEvents(pollStartedAt);
    pollState.lastPollCompletedAt = Date.now();
    pollState.lastPollStatus = "down";
    pollState.lastPollError = err.message;
    pollState.lastEventCount = 0;
    pollState.lastNotificationCount = notificationCount;
    pollState.lastNotificationFailureCount = notificationFailureCount;
  } finally {
    pollState.isPolling = false;
  }
}

async function runPollLoop() {
  const cycleStartedAt = Date.now();
  await poll();
  const delayMs = Math.max(0, POLL_INTERVAL_MS - (Date.now() - cycleStartedAt));
  setTimeout(runPollLoop, delayMs);
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

// ── Health checks ─────────────────────────────────────────────────────────────
async function runHealthChecks() {
  const nowMs = Date.now();
  const lastSuccessAgeMs = pollState.lastSuccessfulPollAt === null
    ? null
    : nowMs - pollState.lastSuccessfulPollAt;
  const currentPollAgeMs = pollState.isPolling && pollState.lastPollStartedAt !== null
    ? nowMs - pollState.lastPollStartedAt
    : null;

  let status = "ok";

  if (pollState.lastSuccessfulPollAt === null) {
    status = pollState.isPolling ? "starting" : "down";
  } else if (lastSuccessAgeMs > STALE_POLL_THRESHOLD_MS) {
    status = pollState.isPolling && currentPollAgeMs !== null && currentPollAgeMs <= STALE_POLL_THRESHOLD_MS
      ? "degraded"
      : "down";
  } else if (pollState.lastPollStatus === "down" || pollState.lastPollStatus === "degraded") {
    status = "degraded";
  }

  const report = {
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.floor((nowMs - startedAt) / 1000),
    calendar: {
      status,
      isPolling: pollState.isPolling,
      lastPollStartedAt: toIsoOrNull(pollState.lastPollStartedAt),
      lastPollCompletedAt: toIsoOrNull(pollState.lastPollCompletedAt),
      lastSuccessfulPollAt: toIsoOrNull(pollState.lastSuccessfulPollAt),
      secondsSinceLastSuccessfulPoll: lastSuccessAgeMs === null ? null : Math.floor(lastSuccessAgeMs / 1000),
      staleAfterSeconds: Math.floor(STALE_POLL_THRESHOLD_MS / 1000),
      lastPollStatus: pollState.lastPollStatus,
      lastPollError: pollState.lastPollError,
      lastEventCount: pollState.lastEventCount,
      lastNotificationCount: pollState.lastNotificationCount,
      lastNotificationFailureCount: pollState.lastNotificationFailureCount,
      lastWindowStartAt: toIsoOrNull(pollState.lastWindowStartAt),
      lastWindowEndAt: toIsoOrNull(pollState.lastWindowEndAt),
    },
  };

  return report;
}


function isAuthorized(req, query) {
  const bearer = req.headers.authorization ?? "";
  const queryToken = query.get("token") ?? "";
  return bearer === `Bearer ${NOTIFY_TOKEN}` || queryToken === NOTIFY_TOKEN;
}

const httpServer = http.createServer(async (req, res) => {
  req.setTimeout(10000);
  const { pathname, searchParams } = new URL(req.url, "http://localhost");

  // GET /health — no auth required (used by Fly.io)
  if (req.method === "GET" && pathname === "/health") {
    send(res, 200, { status: "ok", uptime: Math.floor((Date.now() - startedAt) / 1000) });
    return;
  }

  // GET /status — JSON health, requires token (for UptimeRobot)
  if (req.method === "GET" && pathname === "/status") {
    if (!isAuthorized(req, searchParams)) {
      send(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      const checks = await runHealthChecks();
      send(res, 200, checks);
    } catch (err) {
      send(res, 200, { status: "down", error: err.message });
    }
    return;
  }

  // POST /notify — requires token
  if (req.method === "POST" && pathname === "/notify") {
    if (!isAuthorized(req, searchParams)) {
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
runPollLoop();
