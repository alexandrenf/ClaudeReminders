/**
 * reminder.js — drop-in replacement for worker.js
 *
 * Adds a lightweight HTTP server alongside the existing calendar polling logic:
 *   GET  /health  → 200 { status: "ok", uptime: <seconds> }   (no auth, used by Fly.io)
 *   GET  /status  → JSON poll status report                    (requires Bearer NOTIFY_TOKEN, for UptimeRobot)
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
const OUTBOUND_REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_NOTIFICATION_ATTEMPTS = 4;
const MAX_NOTIFICATION_BACKOFF_MS = 15 * 60 * 1000;
const FIRED_EVENT_RETENTION_MS = FIRE_WINDOW_MS + POLL_INTERVAL_MS + LOOKBACK_BUFFER_MS;
const FAILED_EVENT_RETENTION_MS = FIRE_WINDOW_MS + MAX_NOTIFICATION_BACKOFF_MS + LOOKBACK_BUFFER_MS;
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
const eventStates = new Map();
const startedAt = Date.now();
let lastSuccessfulWindowEndAt = startedAt;
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
  lastSuccessfulWindowEndAt,
  lastWindowStartAt: null,
  lastWindowEndAt: null,
  trackedEventCount: 0,
  pendingRetryCount: 0,
  exhaustedEventCount: 0,
  healthSource: "cached_poll_state",
};

function createTimeoutError(label, timeoutMs) {
  const err = new Error(`${label} timed out after ${timeoutMs}ms`);
  err.name = "TimeoutError";
  return err;
}

async function withTimeout(run, timeoutMs, label) {
  let timer;

  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createTimeoutError(label, timeoutMs)), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function computePollWindow({
  startedAtMs,
  lastSuccessfulWindowEndAtMs,
  pollStartedAtMs,
  lookbackBufferMs = LOOKBACK_BUFFER_MS,
  fireWindowMs = FIRE_WINDOW_MS,
}) {
  return {
    windowStartMs: Math.max(startedAtMs, lastSuccessfulWindowEndAtMs - lookbackBufferMs),
    windowEndMs: pollStartedAtMs + fireWindowMs,
  };
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

function getNotificationTitle(event) {
  return event.summary || "Reminder";
}

function getNotificationMessage(event) {
  return event.description || "";
}

function createNotificationState({
  eventKey,
  eventId,
  title,
  message,
  eventStartMs,
  observedAtMs,
}) {
  return {
    eventKey,
    eventId,
    title,
    message,
    eventStartMs,
    firstObservedAt: observedAtMs,
    lastObservedAt: observedAtMs,
    lastAttemptAt: null,
    nextRetryAt: observedAtMs,
    attemptCount: 0,
    status: "pending",
    lastError: null,
    notifiedAt: null,
  };
}

function upsertNotificationStateFromEvent(event, observedAtMs) {
  const eventKey = getEventNotificationKey(event);
  const existing = eventStates.get(eventKey);

  if (existing) {
    existing.eventId = event.id;
    existing.title = getNotificationTitle(event);
    existing.message = getNotificationMessage(event);
    existing.eventStartMs = getEventStartMs(event);
    existing.lastObservedAt = observedAtMs;
    return existing;
  }

  const state = createNotificationState({
    eventKey,
    eventId: event.id,
    title: getNotificationTitle(event),
    message: getNotificationMessage(event),
    eventStartMs: getEventStartMs(event),
    observedAtMs,
  });
  eventStates.set(eventKey, state);
  return state;
}

function computeRetryDelayMs(attemptCount) {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(POLL_INTERVAL_MS * (2 ** exponent), MAX_NOTIFICATION_BACKOFF_MS);
}

function shouldAttemptNotification(state, nowMs) {
  if (state.status === "sent" || state.status === "exhausted") return false;
  if (state.nextRetryAt === null) return false;
  return state.nextRetryAt <= nowMs;
}

function recordNotificationSuccess(state, attemptedAtMs) {
  state.attemptCount += 1;
  state.lastAttemptAt = attemptedAtMs;
  state.nextRetryAt = null;
  state.status = "sent";
  state.lastError = null;
  state.notifiedAt = attemptedAtMs;
}

function recordNotificationFailure(state, attemptedAtMs, errorMessage) {
  state.attemptCount += 1;
  state.lastAttemptAt = attemptedAtMs;
  state.lastError = errorMessage;

  if (state.attemptCount >= MAX_NOTIFICATION_ATTEMPTS) {
    state.nextRetryAt = null;
    state.status = "exhausted";
    return;
  }

  state.nextRetryAt = attemptedAtMs + computeRetryDelayMs(state.attemptCount);
  state.status = "failed";
}

function shouldPruneNotificationState(state, nowMs) {
  const referenceMs = state.eventStartMs
    ?? state.notifiedAt
    ?? state.lastAttemptAt
    ?? state.lastObservedAt
    ?? state.firstObservedAt;
  const retentionMs = state.status === "sent" ? FIRED_EVENT_RETENTION_MS : FAILED_EVENT_RETENTION_MS;

  return referenceMs < nowMs - retentionMs;
}

function pruneNotificationStates(nowMs) {
  for (const [eventKey, state] of eventStates) {
    if (shouldPruneNotificationState(state, nowMs)) eventStates.delete(eventKey);
  }
}

function updateNotificationStateMetrics() {
  let pendingRetryCount = 0;
  let exhaustedEventCount = 0;

  for (const state of eventStates.values()) {
    if (state.status === "failed" || state.status === "pending") pendingRetryCount += 1;
    if (state.status === "exhausted") exhaustedEventCount += 1;
  }

  pollState.trackedEventCount = eventStates.size;
  pollState.pendingRetryCount = pendingRetryCount;
  pollState.exhaustedEventCount = exhaustedEventCount;
}

async function listCalendarEvents(calendar, timeMin, timeMax) {
  const items = [];
  let pageToken;

  do {
    const res = await withTimeout(
      () => calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
        pageToken,
        fields: "items(id,summary,description,start,originalStartTime),nextPageToken",
      }, { timeout: OUTBOUND_REQUEST_TIMEOUT_MS }),
      OUTBOUND_REQUEST_TIMEOUT_MS + 1000,
      "Google Calendar request",
    );

    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return items;
}

// ── Pushover ──────────────────────────────────────────────────────────────────
async function sendPushover(title, message) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OUTBOUND_REQUEST_TIMEOUT_MS);
  if (typeof timeoutId.unref === "function") timeoutId.unref();

  let res;
  try {
    res = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: PUSHOVER_TOKEN,
        user: PUSHOVER_USER,
        title: `🔔 ${title}`,
        message: message || "No description.",
        sound: "magic",
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw createTimeoutError("Pushover request", OUTBOUND_REQUEST_TIMEOUT_MS);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Pushover request failed with HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  if (data.status !== 1) {
    console.error("Pushover error:", data);
    throw new Error(`Pushover rejected: ${JSON.stringify(data)}`);
  }
  console.log(`[${new Date().toISOString()}] Notification sent: "${title}"`);
}

// ── Calendar polling ──────────────────────────────────────────────────────────
async function poll() {
  const pollStartedAt = Date.now();
  const { windowStartMs, windowEndMs } = computePollWindow({
    startedAtMs: startedAt,
    lastSuccessfulWindowEndAtMs: lastSuccessfulWindowEndAt,
    pollStartedAtMs: pollStartedAt,
  });
  let notificationCount = 0;
  let notificationFailureCount = 0;
  let events = [];
  let calendarError = null;

  pollState.isPolling = true;
  pollState.lastPollStartedAt = pollStartedAt;
  pollState.lastWindowStartAt = windowStartMs;
  pollState.lastWindowEndAt = windowEndMs;
  pollState.lastPollError = null;

  try {
    try {
      const calendar = getCalendarClient();
      events = await listCalendarEvents(
        calendar,
        new Date(windowStartMs).toISOString(),
        new Date(windowEndMs).toISOString(),
      );
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Poll error:`, err.message);
      calendarError = err;
    }

    for (const event of events) {
      upsertNotificationStateFromEvent(event, pollStartedAt);
    }

    const dueStates = Array
      .from(eventStates.values())
      .filter((state) => shouldAttemptNotification(state, pollStartedAt))
      .sort((left, right) => {
        const leftOrder = left.eventStartMs ?? left.firstObservedAt;
        const rightOrder = right.eventStartMs ?? right.firstObservedAt;
        return leftOrder - rightOrder;
      });

    for (const state of dueStates) {
      const attemptedAtMs = Date.now();

      try {
        await sendPushover(state.title, state.message);
        recordNotificationSuccess(state, attemptedAtMs);
        notificationCount += 1;
      } catch (err) {
        recordNotificationFailure(state, attemptedAtMs, err.message);
        notificationFailureCount += 1;
        console.error(`[${new Date().toISOString()}] Notification error for event ${state.eventId}:`, err.message);
      }
    }
  } finally {
    const completedAt = Date.now();

    pruneNotificationStates(completedAt);
    updateNotificationStateMetrics();

    if (calendarError === null) {
      lastSuccessfulWindowEndAt = windowEndMs;
      pollState.lastSuccessfulPollAt = completedAt;
      pollState.lastSuccessfulWindowEndAt = lastSuccessfulWindowEndAt;
    }

    pollState.lastPollCompletedAt = completedAt;
    pollState.lastPollStatus = calendarError
      ? "down"
      : (notificationFailureCount > 0 ? "degraded" : "ok");
    pollState.lastPollError = calendarError
      ? calendarError.message
      : (notificationFailureCount > 0
        ? `${notificationFailureCount} notification(s) failed during the last poll`
        : null);
    pollState.lastEventCount = events.length;
    pollState.lastNotificationCount = notificationCount;
    pollState.lastNotificationFailureCount = notificationFailureCount;
    pollState.isPolling = false;
  }
}

async function runPollLoop() {
  const cycleStartedAt = Date.now();
  try {
    await poll();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Unhandled poll loop error:`, err);
  } finally {
    const delayMs = Math.max(0, POLL_INTERVAL_MS - (Date.now() - cycleStartedAt));
    setTimeout(runPollLoop, delayMs);
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

// ── Health checks ─────────────────────────────────────────────────────────────
function getOverallStatus(
  nowMs,
  {
    startedAtMs = startedAt,
    pollState: currentPollState = pollState,
    stalePollThresholdMs = STALE_POLL_THRESHOLD_MS,
  } = {},
) {
  const lastSuccessAgeMs = currentPollState.lastSuccessfulPollAt === null
    ? null
    : nowMs - currentPollState.lastSuccessfulPollAt;
  const currentPollAgeMs = currentPollState.isPolling && currentPollState.lastPollStartedAt !== null
    ? nowMs - currentPollState.lastPollStartedAt
    : null;

  if (currentPollState.lastSuccessfulPollAt === null) {
    return nowMs - startedAtMs <= stalePollThresholdMs ? "starting" : "down";
  }

  if (lastSuccessAgeMs > stalePollThresholdMs) {
    return currentPollState.isPolling && currentPollAgeMs !== null && currentPollAgeMs <= stalePollThresholdMs
      ? "degraded"
      : "down";
  }

  if (currentPollState.lastPollStatus === "down" || currentPollState.lastPollStatus === "degraded") {
    return "degraded";
  }

  return "ok";
}

async function runHealthChecks() {
  const nowMs = Date.now();
  const lastSuccessAgeMs = pollState.lastSuccessfulPollAt === null
    ? null
    : nowMs - pollState.lastSuccessfulPollAt;
  const status = getOverallStatus(nowMs);

  const report = {
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.floor((nowMs - startedAt) / 1000),
    calendar: {
      status,
      observedVia: pollState.healthSource,
      isPolling: pollState.isPolling,
      lastPollStartedAt: toIsoOrNull(pollState.lastPollStartedAt),
      lastPollCompletedAt: toIsoOrNull(pollState.lastPollCompletedAt),
      lastSuccessfulPollAt: toIsoOrNull(pollState.lastSuccessfulPollAt),
      lastSuccessfulWindowEndAt: toIsoOrNull(pollState.lastSuccessfulWindowEndAt),
      secondsSinceLastSuccessfulPoll: lastSuccessAgeMs === null ? null : Math.floor(lastSuccessAgeMs / 1000),
      staleAfterSeconds: Math.floor(STALE_POLL_THRESHOLD_MS / 1000),
      lastPollStatus: pollState.lastPollStatus,
      lastPollError: pollState.lastPollError,
      lastEventCount: pollState.lastEventCount,
      lastNotificationCount: pollState.lastNotificationCount,
      lastNotificationFailureCount: pollState.lastNotificationFailureCount,
      lastWindowStartAt: toIsoOrNull(pollState.lastWindowStartAt),
      lastWindowEndAt: toIsoOrNull(pollState.lastWindowEndAt),
      trackedEventCount: pollState.trackedEventCount,
      pendingRetryCount: pollState.pendingRetryCount,
      exhaustedEventCount: pollState.exhaustedEventCount,
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
function start() {
  validateEnv();

  httpServer.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] HTTP server listening on port ${PORT}`);
  });

  console.log(`[${new Date().toISOString()}] Worker started. Polling every ${POLL_INTERVAL_MS / 1000}s`);
  runPollLoop();
}

if (require.main === module) {
  start();
}

module.exports = {
  computePollWindow,
  computeRetryDelayMs,
  createNotificationState,
  shouldAttemptNotification,
  recordNotificationFailure,
  recordNotificationSuccess,
  shouldPruneNotificationState,
  getOverallStatus,
  constants: {
    FIRE_WINDOW_MS,
    LOOKBACK_BUFFER_MS,
    POLL_INTERVAL_MS,
    MAX_NOTIFICATION_ATTEMPTS,
    STALE_POLL_THRESHOLD_MS,
  },
};
