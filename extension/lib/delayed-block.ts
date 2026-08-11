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

export const DELAYED_BLOCK_INTERVAL_MIN_MS = 45_000;
export const DELAYED_BLOCK_INTERVAL_MAX_MS = 75_000;
export const DELAYED_BLOCK_HOURLY_LIMIT = 60;
export const DELAYED_BLOCK_DAILY_LIMIT = 360;

const K_STATES = "xss:delayed-block:states:v2";
const K_STATES_V1 = "xss:delayed-block:states:v1";
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

export type DelayedBlockSkipReason =
  | "mute"
  | "policy_cap"
  | "superseded"
  | "target_unavailable";

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
  /** Canonical queue key: immutable numeric userId, or h:<lowercase handle>. */
  targetKey: string;
  /** Preferred immutable identity. Absent only when the action must use screen_name. */
  userId?: string;
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
  unavailable: number;
  invalidTarget: number;
  hourAttempts: number;
  dayAttempts: number;
  nextRunAt?: number;
  pauseReason?: DelayedBlockPauseReason;
}

export type RateDecision =
  | { allowed: true; hourAttempts: number; dayAttempts: number }
  | {
      allowed: false;
      reason: "hourly_limit" | "daily_limit";
      nextAt: number;
      hourAttempts: number;
      dayAttempts: number;
    };

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

export function normalizeDelayedBlockHandle(handle: string | undefined): string | undefined {
  const normalized = handle?.trim().replace(/^@+/, "").toLowerCase();
  return normalized && /^[a-z0-9_]{1,15}$/.test(normalized) ? normalized : undefined;
}

export interface DelayedBlockTarget {
  key: string;
  handle: string;
  userId?: string;
}

/** Prefer X's immutable numeric id; fall back to its validated screen_name. */
export function delayedBlockTarget(
  userId: string | undefined,
  handle: string | undefined,
): DelayedBlockTarget | null {
  const normalizedHandle = normalizeDelayedBlockHandle(handle);
  if (isNumericUserId(userId)) {
    return {
      key: userId,
      userId,
      handle: normalizedHandle ?? handle?.trim().replace(/^@+/, "") ?? "",
    };
  }
  return normalizedHandle
    ? { key: `h:${normalizedHandle}`, handle: normalizedHandle }
    : null;
}

export function delayedBlockTargetForRecord(record: BlockRecord): DelayedBlockTarget | null {
  const fallbackHandle = record.id.startsWith("h:") ? record.id.slice(2) : undefined;
  return delayedBlockTarget(
    isNumericUserId(record.id) ? record.id : undefined,
    normalizeDelayedBlockHandle(record.handle) ? record.handle : fallbackHandle,
  );
}

function normalizeStoredStates(raw: unknown): DelayedBlockStates {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const normalized: DelayedBlockStates = {};
  for (const [storedKey, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const state = value as Partial<DelayedBlockState> & { userId?: string };
    const legacyTarget = state.targetKey ?? state.userId ?? storedKey;
    const target = delayedBlockTarget(
      isNumericUserId(legacyTarget) ? legacyTarget : state.userId,
      state.handle ?? (legacyTarget.startsWith("h:") ? legacyTarget.slice(2) : undefined),
    );
    if (!target || typeof state.status !== "string" || typeof state.origin !== "string") continue;
    const next = {
      ...state,
      targetKey: target.key,
      handle: target.handle,
      ...(target.userId ? { userId: target.userId } : {}),
    } as DelayedBlockState;
    if (!target.userId) delete next.userId;
    normalized[target.key] = next;
  }
  return normalized;
}

export async function getDelayedBlockStates(): Promise<DelayedBlockStates> {
  const current = await getLocal<unknown | undefined>(K_STATES, undefined);
  if (current !== undefined) return normalizeStoredStates(current);
  // v1 stored numeric-only states with `userId` as both identity and map key.
  // Read it until the next mutation persists the normalized v2 schema.
  return normalizeStoredStates(await getLocal<unknown>(K_STATES_V1, {}));
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
  target: DelayedBlockTarget,
  origin: DelayedBlockOrigin,
  now: number,
): DelayedBlockState {
  return {
    targetKey: target.key,
    ...(target.userId ? { userId: target.userId } : {}),
    handle: target.handle,
    status: "pending",
    origin,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function skippedState(
  target: DelayedBlockTarget,
  origin: DelayedBlockOrigin,
  skipReason: DelayedBlockSkipReason,
  now: number,
): DelayedBlockState {
  return {
    targetKey: target.key,
    ...(target.userId ? { userId: target.userId } : {}),
    handle: target.handle,
    status: "skipped",
    origin,
    skipReason,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function retargetState(
  state: DelayedBlockState,
  target: DelayedBlockTarget,
  patch: Partial<DelayedBlockState> = {},
): DelayedBlockState {
  const next: DelayedBlockState = {
    ...state,
    ...patch,
    targetKey: target.key,
    handle: target.handle,
  };
  if (target.userId) next.userId = target.userId;
  else delete next.userId;
  return next;
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
  const target = delayedBlockTargetForRecord(record);
  if (!target) return null;

  if (record.requestedAction) {
    if (record.requestedAction === "mute") {
      return skippedState(target, "local_hide", "mute", now);
    }
    if (record.requestedAction === "hide") {
      return record.delayedBlockEligible
        ? pendingState(target, "local_hide", now)
        : skippedState(target, "local_hide", "policy_cap", now);
    }
    if (record.effectiveAction === "hide" && !record.delayedBlockEligible) {
      return skippedState(target, "local_hide", "policy_cap", now);
    }
    // A structured direct block is normally settled by
    // recordDirectBlockResult(). The reason fallback only covers a storage
    // write that failed after the foreground path had already annotated the
    // audit row as unsuccessful.
    return /失败|仅本地隐藏/.test(record.reason ?? "")
      ? pendingState(target, "direct_block_retry", now)
      : null;
  }

  const reason = record.reason ?? "";
  if (/静音/.test(reason)) {
    return skippedState(target, "legacy", "mute", now);
  }
  // Legacy text describes the requested action, not a durable X response:
  // the old queue wrote "自动拉黑" before sending the request. Treat every
  // non-mute legacy row as pending so an interrupted write cannot be mistaken
  // for verified success after storage migration.
  return pendingState(target, "legacy", now);
}

function isUnverifiedLegacySuccess(state: DelayedBlockState | undefined): boolean {
  return (
    state?.status === "succeeded" && state.origin === "legacy" && state.attempts === 0
  );
}

function isVerifiedSuccess(state: DelayedBlockState | undefined): state is DelayedBlockState {
  return state?.status === "succeeded" && !isUnverifiedLegacySuccess(state);
}

function requeueUnverifiedLegacySuccess(
  state: DelayedBlockState,
  now: number,
): DelayedBlockState {
  const next: DelayedBlockState = {
    ...state,
    status: "pending",
    updatedAt: now,
  };
  delete next.blockedAt;
  delete next.nextRetryAt;
  delete next.lastHttpStatus;
  delete next.lastError;
  delete next.skipReason;
  return next;
}

function needsTargetUnavailableMigration(state: DelayedBlockState | undefined): boolean {
  return (
    state?.lastHttpStatus === 404 &&
    (state.status === "pending" ||
      state.status === "processing" ||
      state.status === "retry_wait" ||
      state.status === "failed")
  );
}

export function isTargetUnavailableDelayedBlockState(
  state: DelayedBlockState | undefined,
): boolean {
  return state?.skipReason === "target_unavailable" || needsTargetUnavailableMigration(state);
}

function targetUnavailableState(state: DelayedBlockState, now: number): DelayedBlockState {
  const next: DelayedBlockState = {
    ...state,
    status: "skipped",
    skipReason: "target_unavailable",
    updatedAt: now,
    lastHttpStatus: 404,
  };
  delete next.blockedAt;
  delete next.nextRetryAt;
  delete next.lastError;
  return next;
}

interface RecordTarget {
  record: BlockRecord;
  target: DelayedBlockTarget;
}

/** Collapse duplicate handle-only rows when an immutable numeric identity exists. */
function preferredRecordTargets(records: BlockRecord[]): RecordTarget[] {
  const all = records
    .map((record) => ({ record, target: delayedBlockTargetForRecord(record) }))
    .filter((entry): entry is RecordTarget => entry.target !== null);
  const numericHandles = new Set(
    all.filter((entry) => entry.target.userId).map((entry) => entry.target.handle),
  );
  const byKey = new Map<string, RecordTarget>();
  for (const entry of all) {
    if (!entry.target.userId && numericHandles.has(entry.target.handle)) continue;
    const previous = byKey.get(entry.target.key);
    if (!previous || entry.record.ts >= previous.record.ts) byKey.set(entry.target.key, entry);
  }
  return [...byKey.values()];
}

function handleFallbackKey(target: DelayedBlockTarget): string | undefined {
  return target.userId && target.handle ? `h:${target.handle}` : undefined;
}

export function hasActiveDelayedBlockTarget(
  records: BlockRecord[],
  targetKey: string,
): boolean {
  return preferredRecordTargets(records).some(({ target }) => target.key === targetKey);
}

/** Idempotently materialize queue/skip/success states for existing records. */
export async function ensureDelayedStatesForRecords(
  records: BlockRecord[],
  now = Date.now(),
): Promise<DelayedBlockStates> {
  const existing = await getDelayedBlockStates();
  const preferred = preferredRecordTargets(records);
  const requiresWrite = preferred.some(({ target }) => {
    const current = existing[target.key];
    const fallbackKey = handleFallbackKey(target);
    const fallback = fallbackKey ? existing[fallbackKey] : undefined;
    return (
      !current ||
      needsTargetUnavailableMigration(current) ||
      isUnverifiedLegacySuccess(current) ||
      (!!fallback && fallback.skipReason !== "superseded") ||
      (isVerifiedSuccess(fallback) && current.status !== "succeeded")
    );
  });
  if (!requiresWrite) return existing;
  return mutateStates((states) => {
    for (const { record, target } of preferredRecordTargets(records)) {
      const fallbackKey = handleFallbackKey(target);
      const fallback = fallbackKey ? states[fallbackKey] : undefined;
      let current = states[target.key];
      if (needsTargetUnavailableMigration(current) && current) {
        current = targetUnavailableState(current, now);
        states[target.key] = current;
      } else if (isUnverifiedLegacySuccess(current) && current) {
        current = requeueUnverifiedLegacySuccess(current, now);
        states[target.key] = current;
      }
      const verifiedFallbackSuccess = isVerifiedSuccess(fallback);
      if (!current) {
        const initial = initialDelayedStateForRecord(record, now);
        // Only success is identity-level truth that may override the newer
        // record's action policy. Pending/failed fallback state must not turn
        // a later known mute or safety-capped record into a block candidate.
        if (verifiedFallbackSuccess && fallback) {
          states[target.key] = retargetState(fallback, target, { updatedAt: now });
        } else if (initial) {
          states[target.key] = initial;
        }
      } else if (verifiedFallbackSuccess && fallback && current.status !== "succeeded") {
        states[target.key] = retargetState(fallback, target, { updatedAt: now });
      }
      if (fallbackKey && fallback && fallback.skipReason !== "superseded") {
        states[fallbackKey] = {
          ...fallback,
          status: "skipped",
          skipReason: "superseded",
          updatedAt: now,
        };
      }
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
  const target = delayedBlockTarget(userId, handle);
  if (!target) return;
  await mutateStates((states) => {
    const current = states[target.key];
    if (
      current?.status === "succeeded" ||
      current?.status === "processing" ||
      isTargetUnavailableDelayedBlockState(current)
    ) {
      return;
    }
    states[target.key] = retargetState(current ?? pendingState(target, origin, now), target, {
      origin,
      status: "pending",
      updatedAt: now,
      nextRetryAt: undefined,
      lastError: undefined,
      skipReason: undefined,
    });
  });
}

/** Immediate X-block results share the same success ledger as delayed work. */
export async function recordDirectBlockResult(
  userId: string | undefined,
  handle: string,
  attempt: XActionAttempt,
  now = Date.now(),
): Promise<void> {
  const target = delayedBlockTarget(userId, handle);
  if (!target) return;
  await mutateStates((states) => {
    const current = states[target.key] ?? pendingState(target, "direct_block_retry", now);
    // Once X acknowledged a block, a later duplicate/transient foreground
    // failure must never erase the durable dedupe truth.
    if (current.status === "succeeded" && !attempt.ok) return;
    if (attempt.ok) {
      states[target.key] = retargetState(current, target, {
        status: "succeeded",
        updatedAt: now,
        blockedAt: now,
        lastHttpStatus: attempt.status,
        nextRetryAt: undefined,
        lastError: undefined,
        skipReason: undefined,
      });
      return;
    }
    if (attempt.status === 404) {
      states[target.key] = targetUnavailableState(
        retargetState(current, target, {
          origin: "direct_block_retry",
          lastHttpStatus: 404,
        }),
        now,
      );
      return;
    }
    states[target.key] = retargetState(current, target, {
      origin: "direct_block_retry",
      status: "pending",
      updatedAt: now,
      lastHttpStatus: attempt.status,
      lastError: attempt.status ? `HTTP ${attempt.status}` : "network_error",
      nextRetryAt: undefined,
      skipReason: undefined,
    });
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
  const activeIds = new Set(preferredRecordTargets(records).map(({ target }) => target.key));
  const candidates = Object.values(states).filter((state) => {
    if (!activeIds.has(state.targetKey)) return false;
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
  targetKey: string,
  now = Date.now(),
): Promise<DelayedBlockState | null> {
  return mutateStates((states) => {
    const state = states[targetKey];
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
  targetKey: string,
  attempt: XActionAttempt,
  now = Date.now(),
): Promise<DelayedAttemptSettlement | null> {
  return mutateStates((states) => {
    const state = states[targetKey];
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

    if (attempt.status === 404) {
      const unavailable = targetUnavailableState(state, now);
      states[targetKey] = unavailable;
      return { state: { ...unavailable } };
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

export function isDelayedBlockHardStopped(
  meta: DelayedBlockMeta,
  now = Date.now(),
): boolean {
  return (
    meta.pauseReason === "http_401" ||
    meta.pauseReason === "http_403" ||
    (meta.pauseReason === "http_429" &&
      (meta.pausedUntil ?? Number.POSITIVE_INFINITY) > now)
  );
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
    if (isDelayedBlockHardStopped(meta, now) || (meta.nextRunAt ?? 0) > now) return null;

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

export function setDelayedBlockPause(
  reason: DelayedBlockPauseReason,
  now = Date.now(),
  until?: number,
): Promise<DelayedBlockMeta> {
  return updateDelayedBlockMeta({
    pauseReason: reason,
    pausedAt: now,
    pausedUntil: until,
    nextRunAt: until,
    lastRunnerAt: now,
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
  const preferred = preferredRecordTargets(records);
  const activeIds = new Set(preferred.map(({ target }) => target.key));
  const targets = records.map(delayedBlockTargetForRecord);
  const summary: DelayedBlockSummary = {
    pending: 0,
    processing: 0,
    succeeded: 0,
    retryWait: 0,
    failed: 0,
    skipped: 0,
    unavailable: 0,
    invalidTarget: targets.filter((target) => !target).length,
    hourAttempts: 0,
    dayAttempts: 0,
    ...(meta.nextRunAt ? { nextRunAt: meta.nextRunAt } : {}),
    ...(meta.pauseReason ? { pauseReason: meta.pauseReason } : {}),
  };
  for (const state of Object.values(states)) {
    if (!activeIds.has(state.targetKey)) continue;
    if (isTargetUnavailableDelayedBlockState(state)) {
      summary.skipped += 1;
      summary.unavailable += 1;
      continue;
    }
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
