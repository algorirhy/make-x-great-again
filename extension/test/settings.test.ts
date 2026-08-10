import assert from "node:assert/strict";
import test from "node:test";
import { getSettings } from "../lib/settings";

test("preserves X-native action settings across browser builds", async () => {
  const root = globalThis as unknown as { chrome?: unknown };
  const previousChrome = root.chrome;
  root.chrome = {
    storage: {
      local: {
        get: async () => ({
          "xss:settings": {
            actionMode: "mute",
            categoryActions: { porn: "block", crypto: "mute" },
          },
        }),
      },
    },
  };

  try {
    const settings = await getSettings();
    assert.equal(settings.actionMode, "mute");
    assert.equal(settings.categoryActions.porn, "block");
    assert.equal(settings.categoryActions.crypto, "mute");
    assert.equal(settings.categoryActions.gambling, "badge");
    assert.equal(settings.delayedAutoBlock, false);
    assert.equal(settings.delayedBlockOwnerHandle, "");
  } finally {
    if (previousChrome === undefined) delete root.chrome;
    else root.chrome = previousChrome;
  }
});
