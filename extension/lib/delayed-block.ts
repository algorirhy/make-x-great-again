import type { BlockRecord } from "./store";
import type { XActionAttempt } from "./x-action";

/**
 * Persistent, opt-in delayed X-block queue.
 *
 * The queue is deliberately separate from `xss:pending-actions`: that key is
 * only a crash-recovery marker for an immediate mute/block and is cleared
 * once the foreground action settles.  Delayed blocking needs a durable
 * success ledger so an account is not sent to X again on every page load.
 */

export const DELAYED_BLOCK_INTERVAL_MIN_MS = 60_000;
export const DELAYED_BLOCK_INTERVAL_MAX_MS = 120_000;
export const DELAYED_BLOCK_HOURLY_LIMIT = 30;
export const DELAYED_BLOCK_DAILY_LIMIT = 200;

const K_STATES = "xss:delayed-block:states:v1";
const K_META = "xss:delayed-block:meta:v1";
const STORAGE_LOCK = "mxga-delayed-block-storage";

export type DelayedBlockStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "retry_wait"
  | "failed"
  | "skipped";

export type DelayedBlockOrigin = "local_hide" | "direct_block_retry" | "legacy";

export type DelayedBlockSkipReason = "mute" | "policy_cap";

export type DelayedBlockPauseReason =
  | "idle"
  | "disabled"
  | "not_logged_in"
  | "account_mismatch"
  | "hourly_limit"
  | "daily_limit"
  | "http_401"
  | "http_403"
  | "http_429"
  | "storage_error";

export interface DelayedBlockState {
  userId: string;
  handle: string;
  status: DelayedBlockStatus;
  origin: DelayedBlockOrigin;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  blockedAt?: number;
  nextRetryAt?: number;
  lastHttpStatus?: number;
  lastError?: string;
  skipReason?: DelayedBlockSkipReason;
}

export type DelayedBlockStates = Record<string, DelayedBlockState>;

export interface DelayedBlockMeta {
  /** Every POST attempt, including failed attempts, counts against the cap. */
  attemptTimestamps: number[];
  lastAttemptAt?: number;
  nextRunAt?: number;
  pauseReason?: DelayedBlockPauseReason;
  pausedAt?: number;
  pausedUntil?: number;
  lastRunnerAt?: number;
}

export interface DelayedBlockSummary {
  pending: number;
  processing: number;
  succeeded: number;
  retryWait: number;
  failed: number;
  skipped: number;
  missingUserId: number;
  hourAttempts: number;
  dayAttempts: number;
  nextRunAt?: number;
  pauseReason?: DelayedBlockPauseReason;
}

export interface RateDecision {
  allowed: boolean;
  reason?: "hourly_limit" | "daily_limit";
  nextAt?: number;
  hourAttempts: number;
  dayAttempts: number;
}

type LockCapableNavigator = Navigator & {
  locks?: {
    request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
  };
};

let localStorageChain: Promise<unknown> = Promise.resolve();

function withLocalChain<T>(fn: () => Promise<T>): Promise<T> {
  const run = localStorageChain.then(fn, fn);
  localStorageChain = run.catch(() => {});
  return run;
}

/** Serialize queue state writes across X tabs, with an in-context fallback. */
function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLocalChain(async () => {
    const nav = typeof navigator === "undefined" ? undefined : (navigator as LockCapableNavigator);
    return nav?.locks ? nav.locks.request(STORAGE_LOCK, fn) : fn();
  });
}

async function getLocal<T>(key: string, fallback: T): Promise<T> {
  const got = await chrome.storage.local.get(key);
  return (got[key] as T | undefined) ?? fallback;
}

async function setLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export function isNumericUserId(id: string | undefined): id is string {
  return !!id && /^\d+$/.test(id);
}

export async function getDelayedBlockStates(): Promise<DelayedBlockStates> {
  const raw = await getLocal<unknown>(K_STATES, {});
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as DelayedBlockStates)
    : {};
}

export async function getDelayedBlockMeta(): Promise<DelayedBlockMeta> {
  const raw = await getLocal<Partial<DelayedBlockMeta> | null>(K_META, null);
  return {
    ...(raw ?? {}),
    attemptTimestamps: Array.isArray(raw?.attemptTimestamps)
      ? raw.attemptTimestamps.filter((ts): ts is number => typeof ts === "number")
      : [],
  };
}

async function mutateStates<T>(
  mutate: (states: DelayedBlockStates) => T | Promise<T>,
): Promise<T> {
  return withStorageLock(async () => {
    const states = await getDelayedBlockStates();
    const result = await mutate(states);
    await setLocal(K_STATES, states);
    return result;
  });
}

async function mutateMeta<T>(mutate: (meta: DelayedBlockMeta) => T | Promise<T>): Promise<T> {
  return withStorageLock(async () => {
    const meta = await getDelayedBlockMeta();
    const result = await mutate(meta);
    await setLocal(K_META, meta);
    return result;
  });
}

function pendingState(
  userId: string,
  handle: string,
  origin: DelayedBlockOrigin,
  now: number,
): DelayedBlockState {
  return {
    userId,
    handle,
    status: "pending",
    origin,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function skippedState(
  userId: string,
  handle: string,
  origin: DelayedBlockOrigin,
  skipReason: DelayedBlockSkipReason,
  now: number,
): DelayedBlockState {
  return {
    userId,
    handle,
    status: "skipped",
    origin,
    skipReason,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Derive a missing queue entry from an audit record.
 *
 * New records use structured action fields.  Old records necessarily fall
 * back to their human-readable reason; by product decision, ambiguous legacy
 * rows are included, while rows explicitly known to be mutes are excluded.
 */
export function initialDelayedStateForRecord(
  record: BlockRecord,
  now = Date.now(),
): DelayedBlockState | null {
  if (!isNumericUserId(record.id)) return null;

  if (record.requestedAction) {
    if (record.requestedAction === "mute") {
      return skippedState(record.id, record.handle, "local_hide", "mute", now);
    }
    if (record.requestedAction === "hide") {
      return record.delayedBlockEligible
        ? pendingState(record.id, record.handle, "local_hide", now)
        : skippedState(record.id, record.handle, "local_hide", "policy_cap", now);
    }
    if (record.effectiveAction === "hide" && !record.delayedBlockEligible) {
      return skippedState(record.id, record.handle, "local_hide", "policy_cap", now);
    }
    // A structured direct block is normally settled by
    // recordDirectBlockResult(). The reason fallback only covers a storage
    // write that failed after the foreground path had already annotated the
    // audit row as unsuccessful.
    return /失败|仅本地隐藏/.test(record.reason ?? "")
      ? pendingState(record.id, record.handle, "direct_block_retry", now)
      : null;
  }

  const reason = record.reason ?? "";
  const failed = /失败|仅本地隐藏/.test(reason);
  if (/静音/.test(reason)) {
    return skippedState(record.id, record.handle, "legacy", "mute", now);
  }
  if (/拉黑/.test(reason) && !failed) {
    return {
      ...pendingState(record.id, record.handle, "legacy", now),
      status: "succeeded",
      blockedAt: record.ts,
    };
  }
  return pendingState(record.id, record.handle, "legacy", now);
}

/** Idempotently materialize queue/skip/success states for existing records. */
export async function ensureDelayedStatesForRecords(
  records: BlockRecord[],
  now = Date.now(),
): Promise<DelayedBlockStates> {
  const existing = await getDelayedBlockStates();
  const hasMissing = records.some((record) => isNumericUserId(record.id) && !existing[record.id]);
  if (!hasMissing) return existing;
  return mutateStates((states) => {
    for (const record of records) {
      if (!isNumericUserId(record.id) || states[record.id]) continue;
      const initial = initialDelayedStateForRecord(record, now);
      if (initial) states[record.id] = initial;
    }
    return { ...states };
  });
}

/** Queue an explicit local hide, even while the runner setting is off. */
export async function enqueueDelayedBlock(
  userId: string | undefined,
  handle: string,
  origin: Extract<DelayedBlockOrigin, "local_hide" | "direct_block_retry"> = "local_hide",
  now = Date.now(),
): Promise<void> {
  if (!isNumericUserId(userId)) return;
  await mutateStates((states) => {
    const current = states[userId];
    if (current?.status === "succeeded" || current?.status === "processing") return;
    states[userId] = {
      ...(current ?? pendingState(userId, handle, origin, now)),
      handle,
      origin,
      status: "pending",
      updatedAt: now,
      nextRetryAt: undefined,
      lastError: undefined,
      skipReason: undefined,
    };
  });
}

/** Immediate X-block results share the same success ledger as delayed work. */
export async function recordDirectBlockResult(
  userId: string | undefined,
  handle: string,
  attempt: XActionAttempt,
  now = Date.now(),
): Promise<void> {
  if (!isNumericUserId(userId)) return;
  await mutateStates((states) => {
    const current = states[userId] ?? pendingState(userId, handle, "direct_block_retry", now);
    // Once X acknowledged a block, a later duplicate/transient foreground
    // failure must never erase the durable dedupe truth.
    if (current.status === "succeeded" && !attempt.ok) return;
    if (attempt.ok) {
      states[userId] = {
        ...current,
        handle,
        status: "succeeded",
        updatedAt: now,
        blockedAt: now,
        lastHttpStatus: attempt.status,
        nextRetryAt: undefined,
        lastError: undefined,
        skipReason: undefined,
      };
      return;
    }
    states[userId] = {
      ...current,
      handle,
      origin: "direct_block_retry",
      status: "pending",
      updatedAt: now,
      lastHttpStatus: attempt.status,
      lastError: attempt.status ? `HTTP ${attempt.status}` : "network_error",
      nextRetryAt: undefined,
      skipReason: undefined,
    };
  });
}

/** A page died mid-request. Requeue its processing markers on the next load. */
export async function recoverProcessingDelayedBlocks(now = Date.now()): Promise<void> {
  await mutateStates((states) => {
    for (const state of Object.values(states)) {
      if (state.status !== "processing") continue;
      state.status = "pending";
      state.updatedAt = now;
      state.lastError = "页面中断，等待重新确认";
    }
  });
}

export function selectNextDelayedBlock(
  records: BlockRecord[],
  states: DelayedBlockStates,
  now = Date.now(),
): DelayedBlockState | null {
  const activeIds = new Set(records.filter((r) => isNumericUserId(r.id)).map((r) => r.id));
  const candidates = Object.values(states).filter((state) => {
    if (!activeIds.has(state.userId)) return false;
    if (state.status === "pending") return true;
    return state.status === "retry_wait" && (state.nextRetryAt ?? 0) <= now;
  });
  candidates.sort((a, b) => {
    const ap = a.origin === "direct_block_retry" ? 0 : 1;
    const bp = b.origin === "direct_block_retry" ? 0 : 1;
    return ap - bp || a.createdAt - b.createdAt;
  });
  return candidates[0] ?? null;
}

export async function markDelayedBlockProcessing(
  userId: string,
  now = Date.now(),
): Promise<DelayedBlockState | null> {
  return mutateStates((states) => {
    const state = states[userId];
    if (!state || (state.status !== "pending" && state.status !== "retry_wait")) return null;
    state.status = "processing";
    state.attempts += 1;
    state.updatedAt = now;
    state.nextRetryAt = undefined;
    return { ...state };
  });
}

export interface DelayedAttemptSettlement {
  state: DelayedBlockState;
  stop?: {
    reason: Extract<DelayedBlockPauseReason, "http_401" | "http_403" | "http_429">;
    until?: number;
  };
}

export async function settleDelayedBlockAttempt(
  userId: string,
  attempt: XActionAttempt,
  now = Date.now(),
): Promise<DelayedAttemptSettlement | null> {
  return mutateStates((states) => {
    const state = states[userId];
    if (!state) return null;
    state.updatedAt = now;
    state.lastHttpStatus = attempt.status;

    if (attempt.ok) {
      state.status = "succeeded";
      state.blockedAt = now;
      state.nextRetryAt = undefined;
      state.lastError = undefined;
      return { state: { ...state } };
    }

    state.lastError = attempt.status ? `HTTP ${attempt.status}` : "network_error";
    if (attempt.status === 401 || attempt.status === 403) {
      state.status = "retry_wait";
      state.nextRetryAt = undefined;
      return {
        state: { ...state },
        stop: { reason: attempt.status === 401 ? "http_401" : "http_403" },
      };
    }
    if (attempt.status === 429) {
      const until = now + Math.max(60 * 60_000, attempt.retryAfterMs ?? 0);
      state.status = "retry_wait";
      state.nextRetryAt = until;
      return { state: { ...state }, stop: { reason: "http_429", until } };
    }

    const retryable =
      attempt.retryable ||
      attempt.status === undefined ||
      attempt.status === 408 ||
      attempt.status === 425 ||
      (attempt.status ?? 0) >= 500;
    if (retryable && state.attempts < 3) {
      const delay = 5 * 60_000 * 3 ** Math.max(0, state.attempts - 1);
      state.status = "retry_wait";
      state.nextRetryAt = now + delay;
    } else {
      state.status = "failed";
      state.nextRetryAt = undefined;
    }
    return { state: { ...state } };
  });
}

export function trimAttemptTimestamps(timestamps: number[], now = Date.now()): number[] {
  const floor = now - 24 * 60 * 60_000;
  const ceiling = now + 24 * 60 * 60_000;
  // Keep plausible future stamps so a backwards system-clock adjustment
  // cannot silently erase the safety budget. Grossly corrupt values are
  // still discarded to avoid an indefinite lockout.
  return timestamps.filter((ts) => Number.isFinite(ts) && ts > floor && ts <= ceiling);
}

export function delayedBlockRateDecision(
  timestamps: number[],
  now = Date.now(),
): RateDecision {
  const day = trimAttemptTimestamps(timestamps, now).sort((a, b) => a - b);
  const hourFloor = now - 60 * 60_000;
  const hour = day.filter((ts) => ts > hourFloor);
  if (day.length >= DELAYED_BLOCK_DAILY_LIMIT) {
    return {
      allowed: false,
      reason: "daily_limit",
      nextAt: (day[0] ?? now) + 24 * 60 * 60_000,
      hourAttempts: hour.length,
      dayAttempts: day.length,
    };
  }
  if (hour.length >= DELAYED_BLOCK_HOURLY_LIMIT) {
    return {
      allowed: false,
      reason: "hourly_limit",
      nextAt: (hour[0] ?? now) + 60 * 60_000,
      hourAttempts: hour.length,
      dayAttempts: day.length,
    };
  }
  return { allowed: true, hourAttempts: hour.length, dayAttempts: day.length };
}

/**
 * Atomically reserve one request from the rolling budget.
 *
 * Returning null means another action established a hard stop / cooldown
 * after the runner's previous read. This closes the check-then-send race.
 */
export async function recordDelayedBlockAttempt(
  now = Date.now(),
): Promise<DelayedBlockMeta | null> {
  return mutateMeta((meta) => {
    const hardStopped =
      meta.pauseReason === "http_401" ||
      meta.pauseReason === "http_403" ||
      (meta.pauseReason === "http_429" &&
        (meta.pausedUntil ?? Number.POSITIVE_INFINITY) > now);
    if (hardStopped || (meta.nextRunAt ?? 0) > now) return null;

    const rate = delayedBlockRateDecision(meta.attemptTimestamps, now);
    if (!rate.allowed) {
      meta.pauseReason = rate.reason;
      meta.pausedAt = now;
      meta.pausedUntil = rate.nextAt;
      meta.nextRunAt = rate.nextAt;
      meta.lastRunnerAt = now;
      return null;
    }

    meta.attemptTimestamps = [...trimAttemptTimestamps(meta.attemptTimestamps, now), now];
    meta.lastAttemptAt = now;
    meta.lastRunnerAt = now;
    meta.pauseReason = undefined;
    meta.pausedAt = undefined;
    meta.pausedUntil = undefined;
    return { ...meta };
  });
}

export async function updateDelayedBlockMeta(
  patch: Partial<Omit<DelayedBlockMeta, "attemptTimestamps">>,
): Promise<DelayedBlockMeta> {
  return mutateMeta((meta) => {
    Object.assign(meta, patch);
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      if (patch[key] === undefined) delete meta[key];
    }
    return { ...meta };
  });
}

export async function clearDelayedBlockStop(): Promise<void> {
  await updateDelayedBlockMeta({
    pauseReason: undefined,
    pausedAt: undefined,
    pausedUntil: undefined,
    nextRunAt: undefined,
  });
}

export function randomDelayedBlockInterval(random = Math.random): number {
  const span = DELAYED_BLOCK_INTERVAL_MAX_MS - DELAYED_BLOCK_INTERVAL_MIN_MS;
  const sample = Math.min(0.999999, Math.max(0, random()));
  return DELAYED_BLOCK_INTERVAL_MIN_MS + Math.floor(sample * (span + 1));
}

export function summarizeDelayedBlocks(
  records: BlockRecord[],
  states: DelayedBlockStates,
  meta: DelayedBlockMeta,
  now = Date.now(),
): DelayedBlockSummary {
  const activeIds = new Set(records.filter((r) => isNumericUserId(r.id)).map((r) => r.id));
  const summary: DelayedBlockSummary = {
    pending: 0,
    processing: 0,
    succeeded: 0,
    retryWait: 0,
    failed: 0,
    skipped: 0,
    missingUserId: records.filter((r) => !isNumericUserId(r.id)).length,
    hourAttempts: 0,
    dayAttempts: 0,
    ...(meta.nextRunAt ? { nextRunAt: meta.nextRunAt } : {}),
    ...(meta.pauseReason ? { pauseReason: meta.pauseReason } : {}),
  };
  for (const state of Object.values(states)) {
    if (!activeIds.has(state.userId)) continue;
    if (state.status === "pending") summary.pending += 1;
    else if (state.status === "processing") summary.processing += 1;
    else if (state.status === "succeeded") summary.succeeded += 1;
    else if (state.status === "retry_wait") summary.retryWait += 1;
    else if (state.status === "failed") summary.failed += 1;
    else summary.skipped += 1;
  }
  const rate = delayedBlockRateDecision(meta.attemptTimestamps, now);
  summary.hourAttempts = rate.hourAttempts;
  summary.dayAttempts = rate.dayAttempts;
  return summary;
}
