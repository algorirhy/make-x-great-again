import assert from "node:assert/strict";
import test from "node:test";
import {
  DELAYED_BLOCK_DAILY_LIMIT,
  DELAYED_BLOCK_HOURLY_LIMIT,
  DELAYED_BLOCK_INTERVAL_MAX_MS,
  DELAYED_BLOCK_INTERVAL_MIN_MS,
  delayedBlockRateDecision,
  ensureDelayedStatesForRecords,
  getDelayedBlockStates,
  initialDelayedStateForRecord,
  markDelayedBlockProcessing,
  randomDelayedBlockInterval,
  recordDelayedBlockAttempt,
  recordDirectBlockResult,
  selectNextDelayedBlock,
  settleDelayedBlockAttempt,
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
  assert.equal(initialDelayedStateForRecord(record({ reason: "色情 · 自动拉黑" }), NOW)?.status, "succeeded");
  assert.equal(initialDelayedStateForRecord(record({ id: "h:target" }), NOW), null);
});

test("candidate selection ignores orphan/success states and prioritizes direct retries", () => {
  const records = [record(), record({ id: "456", handle: "second" })];
  const states: DelayedBlockStates = {
    "123": state({ status: "pending", createdAt: NOW - 20_000 }),
    "456": state({
      userId: "456",
      handle: "second",
      origin: "direct_block_retry",
      createdAt: NOW - 5_000,
    }),
    "789": state({ userId: "789", status: "pending" }), // record was restored locally
  };
  assert.equal(selectNextDelayedBlock(records, states, NOW)?.userId, "456");
  states["456"] = { ...states["456"]!, status: "succeeded" };
  assert.equal(selectNextDelayedBlock(records, states, NOW)?.userId, "123");
});

test("rolling hour/day request caps count attempts, not successes", () => {
  const hour = Array.from(
    { length: DELAYED_BLOCK_HOURLY_LIMIT },
    (_, i) => NOW - 50 * 60_000 + i * 1_000,
  );
  const hourDecision = delayedBlockRateDecision(hour, NOW);
  assert.equal(hourDecision.allowed, false);
  assert.equal(hourDecision.reason, "hourly_limit");

  const day = Array.from(
    { length: DELAYED_BLOCK_DAILY_LIMIT },
    (_, i) => NOW - 23 * 60 * 60_000 + i * 6 * 60_000,
  );
  const dayDecision = delayedBlockRateDecision(day, NOW);
  assert.equal(dayDecision.allowed, false);
  assert.equal(dayDecision.reason, "daily_limit");

  assert.equal(delayedBlockRateDecision([], NOW).allowed, true);
});

test("random interval remains within the documented 1-2 minute range", () => {
  assert.equal(randomDelayedBlockInterval(() => 0), DELAYED_BLOCK_INTERVAL_MIN_MS);
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
    await ensureDelayedStatesForRecords([
      record({ requestedAction: "hide", effectiveAction: "hide", delayedBlockEligible: true }),
    ], NOW);
    assert.equal((await getDelayedBlockStates())["123"]?.status, "pending");

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

    // Use a fresh target for 429 so the success ledger is never downgraded.
    await ensureDelayedStatesForRecords([
      record({
        id: "456",
        handle: "second",
        requestedAction: "hide",
        effectiveAction: "hide",
        delayedBlockEligible: true,
      }),
    ], NOW + 5);
    await markDelayedBlockProcessing("456", NOW + 6);
    const rate = await settleDelayedBlockAttempt(
      "456",
      { ok: false, status: 429, retryable: true, retryAfterMs: 1_000 },
      NOW + 7,
    );
    assert.equal(rate?.stop?.reason, "http_429");
    assert.equal(rate?.stop?.until, NOW + 7 + 60 * 60_000);

    memory["xss:delayed-block:meta:v1"] = {
      attemptTimestamps: [],
      pauseReason: "http_429",
      pausedUntil: NOW + 60 * 60_000,
    };
    assert.equal(await recordDelayedBlockAttempt(NOW + 8), null);
  } finally {
    if (previousChrome === undefined) delete root.chrome;
    else root.chrome = previousChrome;
  }
});
