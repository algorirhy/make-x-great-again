import assert from "node:assert/strict";
import test from "node:test";
import {
  addStoredBlockRecord,
  getStoredBlockRecords,
  removeStoredBlockRecord,
  updateStoredBlockRecord,
} from "../lib/block-record-storage";
import { initialDelayedStateForRecord } from "../lib/delayed-block";
import type { BlockRecord } from "../lib/store";

const K_RECORDS = "xss:blocklist:v2";
const K_HIDDEN = "xss:blocked";

const clone = <T>(value: T): T => structuredClone(value);

test("block records use one serialized writer and repair older orphaned hides", async () => {
  const root = globalThis as unknown as { chrome?: unknown };
  const previousChrome = root.chrome;
  let memory: Record<string, unknown> = {};
  root.chrome = {
    storage: {
      local: {
        get: async (keys: string[]) => {
          // Snapshot before yielding: without the storage serializer, every
          // concurrent add below would read the same empty arrays and the last
          // writer would erase all the others.
          const snapshot = Object.fromEntries(keys.map((key) => [key, clone(memory[key])]));
          await new Promise((resolve) => setTimeout(resolve, 1));
          return snapshot;
        },
        set: async (patch: Record<string, unknown>) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          memory = { ...memory, ...clone(patch) };
        },
      },
    },
  };

  try {
    const records: BlockRecord[] = Array.from({ length: 24 }, (_, index) => ({
      id: String(10_000 + index),
      handle: `target_${index}`,
      requestedAction: "hide",
      effectiveAction: "hide",
      delayedBlockEligible: true,
      source: "auto",
      ts: 1_800_000_000_000 + index,
    }));
    await Promise.all(records.map((record) => addStoredBlockRecord(record)));

    assert.deepEqual(
      (memory[K_RECORDS] as BlockRecord[]).map((record) => record.id).sort(),
      records.map((record) => record.id).sort(),
    );
    assert.deepEqual(
      [...(memory[K_HIDDEN] as string[])].sort(),
      records.map((record) => record.id).sort(),
    );

    await Promise.all([
      updateStoredBlockRecord(records[0]!.id, { reason: "updated" }),
      addStoredBlockRecord({
        id: "20000",
        handle: "added_during_update",
        source: "manual",
        ts: 1_800_000_100_000,
      }),
    ]);
    const afterMixedWrites = memory[K_RECORDS] as BlockRecord[];
    assert.equal(afterMixedWrites.find((row) => row.id === records[0]!.id)?.reason, "updated");
    assert.equal(afterMixedWrites.some((row) => row.id === "20000"), true);

    // Reproduce the old broken state: hidden ids survived, audit rows did not.
    memory = {
      [K_HIDDEN]: ["30000", "h:Recovered_User", "not-valid!"],
      [K_RECORDS]: [],
    };
    const repaired = await getStoredBlockRecords();
    assert.deepEqual(repaired.map((row) => row.id), ["30000", "h:Recovered_User", "not-valid!"]);
    assert.equal(repaired.every((row) => row.source === "recovered"), true);
    assert.equal(initialDelayedStateForRecord(repaired[0]!)?.status, "pending");
    assert.equal(initialDelayedStateForRecord(repaired[1]!)?.status, "pending");
    assert.equal(initialDelayedStateForRecord(repaired[2]!), null);

    // A live, richer record replaces a synthetic recovery row instead of
    // getting discarded by the id-based dedupe.
    await addStoredBlockRecord({
      id: "30000",
      handle: "real_handle",
      requestedAction: "hide",
      effectiveAction: "hide",
      delayedBlockEligible: true,
      source: "auto",
      ts: 1_800_000_200_000,
    });
    const enriched = (memory[K_RECORDS] as BlockRecord[]).find((row) => row.id === "30000");
    assert.equal(enriched?.handle, "real_handle");
    assert.equal(enriched?.source, "auto");

    // Removal updates both keys in one operation, so the next reconciliation
    // cannot resurrect the just-restored account as an orphan.
    await removeStoredBlockRecord("h:Recovered_User");
    const afterRemove = await getStoredBlockRecords();
    assert.equal(afterRemove.some((row) => row.id === "h:Recovered_User"), false);
    assert.equal((memory[K_HIDDEN] as string[]).includes("h:Recovered_User"), false);
  } finally {
    if (previousChrome === undefined) delete root.chrome;
    else root.chrome = previousChrome;
  }
});
