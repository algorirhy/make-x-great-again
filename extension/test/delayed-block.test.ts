import assert from "node:assert/strict";
import test from "node:test";
import {
  DELAYED_BLOCK_DAILY_LIMIT,
  DELAYED_BLOCK_HOURLY_LIMIT,
  DELAYED_BLOCK_INTERVAL_MAX_MS,
  DELAYED_BLOCK_INTERVAL_MIN_MS,
  delayedBlockTarget,
  delayedBlockRateDecision,
  enqueueDelayedBlock,
  ensureDelayedStatesForRecords,
  getDelayedBlockMeta,
  getDelayedBlockStates,
  hasActiveDelayedBlockTarget,
  initialDelayedStateForRecord,
  isDelayedBlockHardStopped,
  markDelayedBlockProcessing,
  randomDelayedBlockInterval,
  recordDelayedBlockAttempt,
  recordDirectBlockResult,
  selectNextDelayedBlock,
  setDelayedBlockPause,
  settleDelayedBlockAttempt,
  summarizeDelayedBlocks,
  type DelayedBlockState,
  type DelayedBlockStates,
} from "../lib/delayed-block";
import type { BlockRecord } from "../lib/store";
import { performXAction } from "../lib/x-action";

const NOW = 1_800_000_000_000;

function record(patch: Partial<BlockRecord> = {}): BlockRecord {
  return {
    id: "123",
    handle: "target",
    source: "auto",
    ts: NOW - 10_000,
    ...patch,
  };
}

function state(patch: Partial<DelayedBlockState> = {}): DelayedBlockState {
  return {
    targetKey: "123",
    userId: "123",
    handle: "target",
    status: "pending",
    origin: "local_hide",
    attempts: 0,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    ...patch,
  };
}

test("structured actions preserve mute and safety-cap boundaries", () => {
  assert.equal(
    initialDelayedStateForRecord(
      record({ requestedAction: "hide", effectiveAction: "hide", delayedBlockEligible: true }),
      NOW,
    )?.status,
    "pending",
  );

  const capped = initialDelayedStateForRecord(
    record({ requestedAction: "block", effectiveAction: "hide", delayedBlockEligible: false }),
    NOW,
  );
  assert.equal(capped?.status, "skipped");
  assert.equal(capped?.skipReason, "policy_cap");

  const explicitCappedHide = initialDelayedStateForRecord(
    record({ requestedAction: "hide", effectiveAction: "hide", delayedBlockEligible: false }),
    NOW,
  );
  assert.equal(explicitCappedHide?.status, "skipped");
  assert.equal(explicitCappedHide?.skipReason, "policy_cap");

  const mute = initialDelayedStateForRecord(
    record({ requestedAction: "mute", effectiveAction: "mute", delayedBlockEligible: false }),
    NOW,
  );
  assert.equal(mute?.status, "skipped");
  assert.equal(mute?.skipReason, "mute");
});

test("legacy migration includes ambiguous rows but excludes known mutes", () => {
  assert.equal(initialDelayedStateForRecord(record({ reason: "色情 · 自动隐藏" }), NOW)?.status, "pending");
  assert.equal(initialDelayedStateForRecord(record({ reason: undefined }), NOW)?.status, "pending");
  assert.equal(
    initialDelayedStateForRecord(record({ reason: "色情 · 自动静音" }), NOW)?.skipReason,
    "mute",
  );
  assert.equal(
    initialDelayedStateForRecord(record({ reason: "自动拉黑（X 动作失败，仅本地隐藏）" }), NOW)?.status,
    "pending",
  );
  assert.equal(initialDelayedStateForRecord(record({ reason: "色情 · 自动拉黑" }), NOW)?.status, "pending");
  const handleOnly = initialDelayedStateForRecord(record({ id: "h:Target", handle: "@Target" }), NOW);
  assert.equal(handleOnly?.status, "pending");
  assert.equal(handleOnly?.targetKey, "h:target");
  assert.equal(handleOnly?.userId, undefined);
  assert.equal(initialDelayedStateForRecord(record({ id: "h:not-valid!", handle: "not-valid!" }), NOW), null);
});

test("target identity prefers numeric userId and validates handle fallback", () => {
  assert.deepEqual(delayedBlockTarget("123", "@Mixed_Case"), {
    key: "123",
    userId: "123",
    handle: "mixed_case",
  });
  assert.deepEqual(delayedBlockTarget(undefined, "@Mixed_Case"), {
    key: "h:mixed_case",
    handle: "mixed_case",
  });
  assert.equal(delayedBlockTarget(undefined, "not-valid!"), null);
  assert.equal(delayedBlockTarget(undefined, "sixteen_chars____"), null);
});

test("candidate selection ignores orphan/success states and prioritizes direct retries", () => {
  const records = [record(), record({ id: "456", handle: "second" })];
  const states: DelayedBlockStates = {
    "123": state({ status: "pending", createdAt: NOW - 20_000 }),
    "456": state({
      targetKey: "456",
      userId: "456",
      handle: "second",
      origin: "direct_block_retry",
      createdAt: NOW - 5_000,
    }),
    "789": state({ targetKey: "789", userId: "789", status: "pending" }), // restored locally
  };
  assert.equal(selectNextDelayedBlock(records, states, NOW)?.targetKey, "456");
  states["456"] = { ...states["456"]!, status: "succeeded" };
  assert.equal(selectNextDelayedBlock(records, states, NOW)?.targetKey, "123");
});

test("candidate selection includes handle-only rows", () => {
  const records = [record({ id: "h:Target", handle: "@Target" })];
  const states: DelayedBlockStates = {
    "h:target": state({ targetKey: "h:target", userId: undefined, handle: "target" }),
  };
  assert.equal(selectNextDelayedBlock(records, states, NOW)?.targetKey, "h:target");
  assert.equal(selectNextDelayedBlock(records, states, NOW)?.userId, undefined);
});

test("numeric identity supersedes a stale handle candidate", () => {
  const records = [
    record({ id: "h:Target", handle: "Target" }),
    record({ id: "999", handle: "target", ts: NOW }),
  ];
  assert.equal(hasActiveDelayedBlockTarget(records, "h:target"), false);
  assert.equal(hasActiveDelayedBlockTarget(records, "999"), true);
});

test("stored 404 failures are presented as unavailable before migration persists", () => {
  const summary = summarizeDelayedBlocks(
    [record()],
    {
      "123": state({
        status: "failed",
        attempts: 1,
        lastHttpStatus: 404,
        lastError: "HTTP 404",
      }),
    },
    { attemptTimestamps: [] },
    NOW,
  );
  assert.equal(summary.unavailable, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 1);
});

test("rolling hour/day request caps count attempts, not successes", () => {
  assert.equal(DELAYED_BLOCK_HOURLY_LIMIT, 60);
  assert.equal(DELAYED_BLOCK_DAILY_LIMIT, 360);
  const hour = Array.from(
    { length: DELAYED_BLOCK_HOURLY_LIMIT },
    (_, i) => NOW - 50 * 60_000 + i * 1_000,
  );
  const hourDecision = delayedBlockRateDecision(hour, NOW);
  assert.equal(hourDecision.allowed, false);
  assert.equal(hourDecision.reason, "hourly_limit");

  const day = Array.from(
    { length: DELAYED_BLOCK_DAILY_LIMIT },
    (_, i) =>
      NOW -
      23 * 60 * 60_000 +
      i * Math.floor((22 * 60 * 60_000) / (DELAYED_BLOCK_DAILY_LIMIT - 1)),
  );
  const dayDecision = delayedBlockRateDecision(day, NOW);
  assert.equal(dayDecision.allowed, false);
  assert.equal(dayDecision.reason, "daily_limit");

  assert.equal(delayedBlockRateDecision([], NOW).allowed, true);
});

test("hard stops distinguish active and expired cooldowns", () => {
  assert.equal(
    isDelayedBlockHardStopped({ attemptTimestamps: [], pauseReason: "http_401" }, NOW),
    true,
  );
  assert.equal(
    isDelayedBlockHardStopped(
      { attemptTimestamps: [], pauseReason: "http_429", pausedUntil: NOW + 1 },
      NOW,
    ),
    true,
  );
  assert.equal(
    isDelayedBlockHardStopped(
      { attemptTimestamps: [], pauseReason: "http_429", pausedUntil: NOW - 1 },
      NOW,
    ),
    false,
  );
});

test("random interval remains within the documented 45-75 second range", () => {
  assert.equal(randomDelayedBlockInterval(() => 0), DELAYED_BLOCK_INTERVAL_MIN_MS);
  assert.equal(randomDelayedBlockInterval(() => 0.5), 60_000);
  assert.equal(randomDelayedBlockInterval(() => 1), DELAYED_BLOCK_INTERVAL_MAX_MS);
});

test("an aborted delayed action never reaches the X request path", async () => {
  const controller = new AbortController();
  controller.abort();
  const attempt = await performXAction("block", "123", "target", {
    signal: controller.signal,
  });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.aborted, true);
  assert.equal(attempt.retryable, false);
});

test("the final safety gate can cancel after pacing but before the X POST", async () => {
  const attempt = await performXAction("block", "123", "target", {
    shouldProceed: async () => false,
  });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.aborted, true);
});

test("persistent state transitions dedupe success and stop on auth/rate errors", async () => {
  const root = globalThis as unknown as { chrome?: unknown };
  const previousChrome = root.chrome;
  let memory: Record<string, unknown> = {};
  root.chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: memory[key] }),
        set: async (patch: Record<string, unknown>) => {
          memory = { ...memory, ...patch };
        },
      },
    },
  };

  try {
    memory["xss:delayed-block:states:v1"] = {
      "776": {
        userId: "776",
        handle: "unverified",
        status: "succeeded",
        origin: "legacy",
        attempts: 0,
        blockedAt: NOW - 20_000,
        createdAt: NOW - 20_000,
        updatedAt: NOW - 20_000,
      },
      "777": {
        userId: "777",
        handle: "legacy",
        status: "succeeded",
        origin: "legacy",
        attempts: 1,
        createdAt: NOW - 20_000,
        updatedAt: NOW - 20_000,
      },
      "775": {
        userId: "775",
        handle: "missing",
        status: "failed",
        origin: "legacy",
        attempts: 1,
        lastHttpStatus: 404,
        lastError: "HTTP 404",
        createdAt: NOW - 20_000,
        updatedAt: NOW - 20_000,
      },
    };
    const migratedV1 = await getDelayedBlockStates();
    assert.equal(migratedV1["777"]?.targetKey, "777");
    assert.equal(migratedV1["777"]?.status, "succeeded");

    await ensureDelayedStatesForRecords([
      record({ requestedAction: "hide", effectiveAction: "hide", delayedBlockEligible: true }),
      record({ id: "776", handle: "unverified", reason: "色情 · 自动拉黑" }),
      record({ id: "775", handle: "missing", reason: "色情 · 自动隐藏" }),
    ], NOW);
    const initialized = await getDelayedBlockStates();
    assert.equal(initialized["123"]?.status, "pending");
    assert.equal(initialized["776"]?.status, "pending");
    assert.equal(initialized["776"]?.blockedAt, undefined);
    assert.equal(initialized["777"]?.status, "succeeded");
    assert.equal(initialized["775"]?.status, "skipped");
    assert.equal(initialized["775"]?.skipReason, "target_unavailable");
    assert.equal(initialized["775"]?.lastError, undefined);

    await markDelayedBlockProcessing("123", NOW + 1);
    const auth = await settleDelayedBlockAttempt(
      "123",
      { ok: false, status: 401, retryable: false },
      NOW + 2,
    );
    assert.equal(auth?.state.status, "retry_wait");
    assert.equal(auth?.stop?.reason, "http_401");

    // A direct foreground success overwrites a queued/retry state and becomes
    // the durable dedupe truth.
    await recordDirectBlockResult("123", "target", { ok: true, status: 200 }, NOW + 3);
    assert.equal((await getDelayedBlockStates())["123"]?.status, "succeeded");
    await recordDirectBlockResult(
      "123",
      "target",
      { ok: false, status: 503, retryable: true },
      NOW + 4,
    );
    assert.equal((await getDelayedBlockStates())["123"]?.status, "succeeded");

    // A handle-only success is reused if a later record discovers the
    // immutable userId, preventing a duplicate POST for the same handle.
    await recordDirectBlockResult(undefined, "@HandleOnly", { ok: true, status: 200 }, NOW + 5);
    assert.equal((await getDelayedBlockStates())["h:handleonly"]?.status, "succeeded");
    await ensureDelayedStatesForRecords([
      record({ id: "h:HandleOnly", handle: "HandleOnly" }),
      record({ id: "999", handle: "HandleOnly" }),
    ], NOW + 6);
    const upgraded = await getDelayedBlockStates();
    assert.equal(upgraded["999"]?.status, "succeeded");
    assert.equal(upgraded["h:handleonly"]?.skipReason, "superseded");

    // Pending handle state must not bypass a later, more precise mute policy.
    await recordDirectBlockResult(
      undefined,
      "MutedLater",
      { ok: false, status: 503, retryable: true },
      NOW + 7,
    );
    await ensureDelayedStatesForRecords([
      record({ id: "h:MutedLater", handle: "MutedLater" }),
      record({
        id: "998",
        handle: "MutedLater",
        requestedAction: "mute",
        effectiveAction: "mute",
        delayedBlockEligible: false,
      }),
    ], NOW + 8);
    const mutedUpgrade = await getDelayedBlockStates();
    assert.equal(mutedUpgrade["998"]?.status, "skipped");
    assert.equal(mutedUpgrade["998"]?.skipReason, "mute");

    // HTTP 404 means X cannot act on the target. It is a terminal,
    // non-failure outcome and repeated local hits must not requeue it.
    await recordDirectBlockResult(
      undefined,
      "GoneUser",
      { ok: false, status: 404, retryable: false },
      NOW + 9,
    );
    let unavailableStates = await getDelayedBlockStates();
    assert.equal(unavailableStates["h:goneuser"]?.status, "skipped");
    assert.equal(unavailableStates["h:goneuser"]?.skipReason, "target_unavailable");
    assert.equal(
      selectNextDelayedBlock(
        [record({ id: "h:GoneUser", handle: "GoneUser" })],
        unavailableStates,
        NOW + 10,
      ),
      null,
    );

    await enqueueDelayedBlock(undefined, "GoneUser", "local_hide", NOW + 11);
    unavailableStates = await getDelayedBlockStates();
    assert.equal(unavailableStates["h:goneuser"]?.skipReason, "target_unavailable");

    await ensureDelayedStatesForRecords([
      record({
        id: "457",
        handle: "deleted",
        requestedAction: "hide",
        effectiveAction: "hide",
        delayedBlockEligible: true,
      }),
    ], NOW + 12);
    await markDelayedBlockProcessing("457", NOW + 13);
    const unavailable = await settleDelayedBlockAttempt(
      "457",
      { ok: false, status: 404, retryable: false },
      NOW + 14,
    );
    assert.equal(unavailable?.state.status, "skipped");
    assert.equal(unavailable?.state.skipReason, "target_unavailable");
    assert.equal(unavailable?.state.attempts, 1);
    assert.equal((await getDelayedBlockStates())["h:deleted"], undefined);
    const unavailableSummary = summarizeDelayedBlocks(
      [record({ id: "457", handle: "deleted" })],
      await getDelayedBlockStates(),
      { attemptTimestamps: [] },
      NOW + 15,
    );
    assert.equal(unavailableSummary.unavailable, 1);
    assert.equal(unavailableSummary.failed, 0);

    // Use a fresh target for 429 so the success ledger is never downgraded.
    await ensureDelayedStatesForRecords([
      record({
        id: "456",
        handle: "second",
        requestedAction: "hide",
        effectiveAction: "hide",
        delayedBlockEligible: true,
      }),
    ], NOW + 16);
    await markDelayedBlockProcessing("456", NOW + 17);
    const rate = await settleDelayedBlockAttempt(
      "456",
      { ok: false, status: 429, retryable: true, retryAfterMs: 1_000 },
      NOW + 18,
    );
    assert.equal(rate?.stop?.reason, "http_429");
    assert.equal(rate?.stop?.until, NOW + 18 + 60 * 60_000);

    await setDelayedBlockPause("disabled", NOW + 19);
    const disabled = await getDelayedBlockMeta();
    assert.equal(disabled.pauseReason, "disabled");
    assert.equal(disabled.nextRunAt, undefined);

    memory["xss:delayed-block:meta:v1"] = {
      attemptTimestamps: [],
      pauseReason: "http_429",
      pausedUntil: NOW + 60 * 60_000,
    };
    assert.equal(await recordDelayedBlockAttempt(NOW + 20), null);
  } finally {
    if (previousChrome === undefined) delete root.chrome;
    else root.chrome = previousChrome;
  }
});
