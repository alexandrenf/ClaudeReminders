const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computePollWindow,
  computeRetryDelayMs,
  createNotificationState,
  shouldAttemptNotification,
  recordNotificationFailure,
  recordNotificationSuccess,
  shouldPruneNotificationState,
  getOverallStatus,
  constants,
} = require("./reminder");

test("computePollWindow overlaps from the previous successful window end", () => {
  const { windowStartMs, windowEndMs } = computePollWindow({
    startedAtMs: 0,
    lastSuccessfulWindowEndAtMs: 120_000,
    pollStartedAtMs: 300_000,
  });

  assert.equal(windowStartMs, 90_000);
  assert.equal(windowEndMs, 420_000);
});

test("failed notifications back off and eventually exhaust", () => {
  const state = createNotificationState({
    eventKey: "evt-1",
    eventId: "evt-1",
    title: "Reminder",
    message: "",
    eventStartMs: 1_000,
    observedAtMs: 0,
  });

  assert.equal(shouldAttemptNotification(state, 0), true);

  recordNotificationFailure(state, 100, "first failure");
  assert.equal(state.status, "failed");
  assert.equal(state.nextRetryAt, 100 + computeRetryDelayMs(1));
  assert.equal(shouldAttemptNotification(state, 101), false);
  assert.equal(shouldAttemptNotification(state, state.nextRetryAt), true);

  recordNotificationFailure(state, state.nextRetryAt, "second failure");
  recordNotificationFailure(state, state.nextRetryAt + computeRetryDelayMs(2), "third failure");
  recordNotificationFailure(state, state.nextRetryAt + computeRetryDelayMs(3), "fourth failure");

  assert.equal(state.status, "exhausted");
  assert.equal(state.nextRetryAt, null);
  assert.equal(shouldAttemptNotification(state, Date.now()), false);
});

test("successful notifications stop retrying and prune on the sent retention window", () => {
  const state = createNotificationState({
    eventKey: "evt-2",
    eventId: "evt-2",
    title: "Reminder",
    message: "",
    eventStartMs: 50_000,
    observedAtMs: 0,
  });

  recordNotificationSuccess(state, 1_000);

  assert.equal(state.status, "sent");
  assert.equal(shouldAttemptNotification(state, 1_001), false);
  assert.equal(shouldPruneNotificationState(state, 50_000 + constants.POLL_INTERVAL_MS), false);
  assert.equal(
    shouldPruneNotificationState(
      state,
      50_000 + constants.FIRE_WINDOW_MS + constants.POLL_INTERVAL_MS + constants.LOOKBACK_BUFFER_MS + 1,
    ),
    true,
  );
});

test("service reports starting during cold start and down after the stale threshold", () => {
  const basePollState = {
    isPolling: false,
    lastPollStartedAt: null,
    lastSuccessfulPollAt: null,
    lastPollStatus: "starting",
  };

  assert.equal(
    getOverallStatus(
      30_000,
      {
        startedAtMs: 0,
        pollState: basePollState,
        stalePollThresholdMs: constants.STALE_POLL_THRESHOLD_MS,
      },
    ),
    "starting",
  );

  assert.equal(
    getOverallStatus(
      constants.STALE_POLL_THRESHOLD_MS + 1,
      {
        startedAtMs: 0,
        pollState: basePollState,
        stalePollThresholdMs: constants.STALE_POLL_THRESHOLD_MS,
      },
    ),
    "down",
  );
});
