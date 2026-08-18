import type { BlockRecord } from "./store";

/**
 * Single-writer storage implementation for local hides and their audit rows.
 *
 * Only the background worker imports this module. Content/options contexts use
 * store.ts messages, so every mutation shares this promise chain even when
 * several X tabs discover accounts in the same scan tick.
 */

const K_RECORDS = "xss:blocklist:v2";
const K_HIDDEN = "xss:blocked";

interface Snapshot {
  records: BlockRecord[];
  hiddenIds: Set<string>;
}

let storageChain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = storageChain.then(fn, fn);
  storageChain = run.catch(() => {});
  return run;
}

function recoveredRecord(id: string, now: number): BlockRecord {
  return {
    id,
    handle: id.startsWith("h:") ? id.slice(2) : id,
    reason: "自动修复：原处理记录缺失",
    source: "recovered",
    ts: now,
  };
}

async function readSnapshot(): Promise<Snapshot> {
  const raw = await chrome.storage.local.get([K_RECORDS, K_HIDDEN]);
  const records = Array.isArray(raw[K_RECORDS])
    ? (raw[K_RECORDS] as BlockRecord[]).filter(
        (row) => row && typeof row === "object" && typeof row.id === "string",
      )
    : [];
  const hiddenIds = new Set(
    Array.isArray(raw[K_HIDDEN])
      ? (raw[K_HIDDEN] as unknown[]).filter((id): id is string => typeof id === "string")
      : [],
  );
  return { records, hiddenIds };
}

/** Restore audit rows lost by older concurrent writes or partial imports. */
function reconcile(snapshot: Snapshot, now = Date.now()): boolean {
  const recorded = new Set(snapshot.records.map((row) => row.id));
  let changed = false;
  for (const id of snapshot.hiddenIds) {
    if (recorded.has(id)) continue;
    snapshot.records.push(recoveredRecord(id, now));
    recorded.add(id);
    changed = true;
  }
  return changed;
}

async function writeSnapshot(snapshot: Snapshot): Promise<void> {
  // One storage operation keeps the fast hide index and recoverable audit row
  // in sync. chrome.storage.onChanged refreshes blocklist.ts's in-memory set.
  await chrome.storage.local.set({
    [K_RECORDS]: snapshot.records,
    [K_HIDDEN]: [...snapshot.hiddenIds],
  });
}

export function getStoredBlockRecords(): Promise<BlockRecord[]> {
  return serialized(async () => {
    const snapshot = await readSnapshot();
    if (reconcile(snapshot)) await writeSnapshot(snapshot);
    return snapshot.records;
  });
}

export function addStoredBlockRecord(record: BlockRecord): Promise<boolean> {
  return serialized(async () => {
    const snapshot = await readSnapshot();
    reconcile(snapshot);
    const index = snapshot.records.findIndex((row) => row.id === record.id);
    let added = false;
    if (index < 0) {
      snapshot.records.push(record);
      added = true;
    } else if (snapshot.records[index]?.source === "recovered") {
      // A live hit may supply the handle/verdict immediately after an older
      // orphan was reconstructed. Prefer that authoritative, richer record.
      snapshot.records[index] = record;
      added = true;
    }
    snapshot.hiddenIds.add(record.id);
    await writeSnapshot(snapshot);
    return added;
  });
}

export function updateStoredBlockRecord(
  id: string,
  patch: Partial<Omit<BlockRecord, "id">>,
): Promise<boolean> {
  return serialized(async () => {
    const snapshot = await readSnapshot();
    reconcile(snapshot);
    const index = snapshot.records.findIndex((row) => row.id === id);
    const current = snapshot.records[index];
    if (!current) return false;
    const merged: BlockRecord = { ...current, ...patch };
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      if (patch[key] === undefined) delete merged[key];
    }
    snapshot.records[index] = merged;
    await writeSnapshot(snapshot);
    return true;
  });
}

export function removeStoredBlockRecord(id: string): Promise<boolean> {
  return serialized(async () => {
    const snapshot = await readSnapshot();
    reconcile(snapshot);
    const before = snapshot.records.length;
    snapshot.records = snapshot.records.filter((row) => row.id !== id);
    const removedHidden = snapshot.hiddenIds.delete(id);
    if (snapshot.records.length !== before || removedHidden) {
      await writeSnapshot(snapshot);
      return true;
    }
    return false;
  });
}
