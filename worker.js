const { google } = require("googleapis");
const fetch = require("node-fetch");

// ── Config from env vars ──────────────────────────────────────────────────────
const CALENDAR_ID = process.env.CALENDAR_ID;
const PUSHOVER_USER = process.env.PUSHOVER_USER;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const FIRE_WINDOW_MS = 2 * 60 * 1000;   // notify if event starts within 2 min

// ── Google Auth ───────────────────────────────────────────────────────────────
// Render env var: GOOGLE_SERVICE_ACCOUNT_JSON (the entire JSON key as a string)
function getCalendarClient() {
  const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
  return google.calendar({ version: "v3", auth });
}

// ── State: track which events we've already fired ────────────────────────────
const firedEvents = new Set();

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
  } else {
    console.log(`[${new Date().toISOString()}] Notification sent: "${title}"`);
  }
}

// ── Poll calendar ─────────────────────────────────────────────────────────────
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

      const title = event.summary || "Reminder";
      const description = event.description || "";
      firedEvents.add(event.id);
      await sendPushover(title, description);
    }

    // Clean up old fired IDs every ~500 polls to avoid unbounded memory growth
    if (firedEvents.size > 500) firedEvents.clear();

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Poll error:`, err.message);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
function validateEnv() {
  const required = [
    "CALENDAR_ID",
    "PUSHOVER_USER",
    "PUSHOVER_TOKEN",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing required env vars:", missing.join(", "));
    process.exit(1);
  }
}

validateEnv();
console.log(`[${new Date().toISOString()}] Worker started. Polling every ${POLL_INTERVAL_MS / 1000}s`);
poll(); // fire immediately on start
setInterval(poll, POLL_INTERVAL_MS);
