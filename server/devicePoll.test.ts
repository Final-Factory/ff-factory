import assert from "node:assert/strict";
import test from "node:test";
import {
  HIDDEN_RECHECK_MS,
  startDevicePoll,
  type PollClock,
  type PollPage,
} from "../shared/devicePoll.ts";

/** The owners' device-request poll (shared/devicePoll.ts, web/src/components/DeviceRequests.tsx), on a stand-in page and clock. */

function page(state = "visible") {
  const fns = new Set<() => void>();
  const p: PollPage & { show(s: string): void; listeners: number } = {
    visibilityState: state,
    addEventListener: (_t, fn) => fns.add(fn),
    removeEventListener: (_t, fn) => fns.delete(fn),
    show(s) {
      p.visibilityState = s;
      for (const fn of fns) fn();
    },
    get listeners() {
      return fns.size;
    },
  };
  return p;
}

function clock() {
  let n = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const c: PollClock & { pending(): number[]; fire(): void } = {
    setTimeout: (fn, ms) => (timers.set(++n, { fn, ms }), n),
    clearTimeout: (t) => void timers.delete(t as number),
    pending: () => [...timers.values()].map((t) => t.ms),
    fire() {
      const [[id, t]] = timers;
      timers.delete(id);
      t.fn();
    },
  };
  return c;
}

const settle = () => new Promise((r) => setImmediate(r));

test("a visible tab asks at once, then after the delay the answer names", async () => {
  const p = page();
  const c = clock();
  let asked = 0;
  const stop = startDevicePoll(async () => (asked++, 20_000), p, c);
  await settle();
  assert.equal(asked, 1);
  assert.deepEqual(c.pending(), [20_000]);
  c.fire();
  await settle();
  assert.equal(asked, 2);
  stop();
  assert.deepEqual(c.pending(), [], "stopped: no timer left");
  assert.equal(p.listeners, 0, "and no listener");
});

test("a hidden tab asks nothing; coming back into view asks at once, not at the next tick (w10)", async () => {
  const p = page("hidden");
  const c = clock();
  let asked = 0;
  const stop = startDevicePoll(async () => (asked++, 5 * 60_000), p, c);
  await settle();
  assert.equal(asked, 0);
  assert.deepEqual(c.pending(), [HIDDEN_RECHECK_MS]);
  p.show("visible");
  await settle();
  assert.equal(asked, 1, "asked as soon as the tab was shown");
  assert.deepEqual(
    c.pending(),
    [5 * 60_000],
    "one timer, the answer’s: the hidden recheck was replaced",
  );
  // Hiding asks nothing; showing again asks again at once.
  p.show("hidden");
  await settle();
  assert.equal(asked, 1);
  p.show("visible");
  await settle();
  assert.equal(asked, 2);
  assert.equal(c.pending().length, 1);
  stop();
  p.show("visible");
  await settle();
  assert.equal(asked, 2, "nothing after stop");
});

test("a failed request waits a minute; a show while one is in flight does not ask twice", async () => {
  const p = page();
  const c = clock();
  let asked = 0;
  let release!: () => void;
  const stop = startDevicePoll(
    () => {
      asked++;
      return new Promise<number>(
        (_res, rej) => (release = () => rej(new Error("offline"))),
      );
    },
    p,
    c,
  );
  await settle();
  p.show("visible");
  await settle();
  assert.equal(asked, 1, "the request in flight answers for both");
  release();
  await settle();
  assert.deepEqual(c.pending(), [60_000]);
  stop();
});
