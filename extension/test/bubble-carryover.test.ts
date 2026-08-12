// Regression: SPA navigation mid-auto-queue must NOT read as 已处理.
// The paced X-action drain (content.ts) survives SPA navigations; before
// this fix, pageReset() dropped queued/processing rows, the pill fell into
// the archive branch ("已处理 N"), and rows finishing after the navigation
// never reached the session archive at all.
//
// createBubble is DOM-heavy but framework-free — a minimal element stub is
// enough as long as the card is never opened (autoExpand: false, onboarding
// pre-seeded). Assertions read the collapsed pill's innerHTML, which is the
// exact surface the user sees mid-queue.
import assert from "node:assert/strict";
import { test } from "node:test";

function stubEl(): Record<string, unknown> {
  const attrs = new Map<string, string>();
  return {
    className: "",
    innerHTML: "",
    style: {},
    children: [] as unknown[],
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute(k: string, v: string) {
      attrs.set(k, v);
    },
    getAttribute(k: string) {
      return attrs.get(k) ?? null;
    },
    append(...n: unknown[]) {
      (this.children as unknown[]).push(...n);
    },
    appendChild(n: unknown) {
      (this.children as unknown[]).push(n);
      return n;
    },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    remove() {},
    cloneNode: () => stubEl(),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    animate: () => ({ onfinish: null }),
    offsetWidth: 0,
  };
}

const g = globalThis as Record<string, unknown>;
g.document = { createElement: () => stubEl() };
g.window = { matchMedia: () => ({ matches: true }) };
// Pre-seed onboarding so createBubble never auto-expands the card.
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => "1", setItem() {} },
  configurable: true,
});

const { createBubble } = await import("../lib/ui");
import type { Finding } from "../lib/ui";

const spam = (handle: string, userId: string): Finding => ({
  handle,
  userId,
  verdict: { label: "spam", confidence: 0.99, reasons: ["test"] },
});

const noopHandlers = {
  onProcess() {},
  onReviewEach() {},
  onDismiss() {},
  onAppeal() {},
};

const pillOf = (bubble: { el: unknown }) =>
  (bubble.el as { children: { innerHTML: string }[] }).children[0] as { innerHTML: string };

test("SPA navigation mid-queue: pill keeps reporting the running queue, not 已处理", () => {
  const bubble = createBubble(noopHandlers, "tr", "拉黑", { autoExpand: false });
  const pill = () => pillOf(bubble);

  const a = spam("alice", "1");
  const b = spam("bob", "2");
  const c = spam("carol", "3");
  bubble.update([a, b, c]);
  for (const f of [a, b, c]) bubble.markAuto(f.userId as string, "queued", "拉黑");
  bubble.markAuto("1", "processing", "拉黑");
  bubble.markAuto("1", "done", "拉黑");
  bubble.markAuto("2", "processing", "拉黑");
  assert.match(pill().innerHTML, /拉黑中/);
  assert.match(pill().innerHTML, /1\/3/);

  // SPA navigation while B is processing and C is still queued.
  bubble.pageReset();
  assert.match(pill().innerHTML, /拉黑中/, "in-flight queue must stay visible after navigation");
  assert.doesNotMatch(
    pill().innerHTML,
    /已处理/,
    "pill claimed 已处理 while the X-action queue was still draining",
  );
  assert.match(pill().innerHTML, /0\/2/, "carried rows restart the visible progress honestly");
});

test("rows finishing after navigation still land in the session archive", () => {
  const bubble = createBubble(noopHandlers, "tr", "拉黑", { autoExpand: false });
  const pill = () => pillOf(bubble);

  const a = spam("alice", "1");
  const b = spam("bob", "2");
  const c = spam("carol", "3");
  bubble.update([a, b, c]);
  for (const f of [a, b, c]) bubble.markAuto(f.userId as string, "queued", "拉黑");
  bubble.markAuto("1", "done", "拉黑");
  bubble.pageReset(); // navigate away: A archived, B+C carried

  // New page pushes its own findings — the wholesale update() replace must
  // not drop the carried in-flight rows.
  const d = spam("dave", "4");
  bubble.update([d]);
  assert.match(pill().innerHTML, /拉黑中/);
  assert.match(pill().innerHTML, /0\/3/, "carried B+C plus new hit D");

  // The queue drains B and C after the navigation.
  bubble.markAuto("2", "processing", "拉黑");
  bubble.markAuto("2", "done", "拉黑");
  bubble.markAuto("3", "processing", "拉黑");
  bubble.markAuto("3", "done", "拉黑");

  // Next navigation: B and C must be archived (before the fix their Finding
  // objects were gone, so the session 已处理 count silently lost them).
  bubble.pageReset();
  assert.match(pill().innerHTML, /已处理/);
  assert.match(pill().innerHTML, />3</, "archive holds A+B+C, not just A");
});

test("local auto-hide can complete without entering the native X queue", () => {
  const bubble = createBubble(noopHandlers, "tr", "隐藏", { autoExpand: false });
  const pill = () => pillOf(bubble);
  const a = spam("alice", "1");

  bubble.update([a]);
  bubble.markAuto("1", "done", "隐藏");
  bubble.pageReset();

  assert.match(pill().innerHTML, /已处理/);
  assert.match(pill().innerHTML, />1</);
  assert.doesNotMatch(pill().innerHTML, /处理中|排队/);
});
