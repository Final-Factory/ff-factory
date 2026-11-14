/**
 * The owners' device-request poll (web/src/components/DeviceRequests.tsx, docs/identity.md "Device approval"). It asks
 * every `next` ms what the last answer said; a hidden tab skips the request and looks again in 20 s, and a tab that comes
 * back into view asks at once (w10: an owner opening a backgrounded tab from the push notice saw the bar up to 20 s late).
 * Kept free of React and the DOM's types so server/devicePoll.test.ts runs it with a stand-in page and clock.
 */

export interface PollPage {
  visibilityState: string;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

export interface PollClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

/** How long a hidden tab waits before it looks again. */
export const HIDDEN_RECHECK_MS = 20_000;

/**
 * Start polling: `ask` makes one request and answers the delay before the next. A failed request waits a minute. Answers
 * the stop function; nothing is asked after it.
 */
export function startDevicePoll(
  ask: () => Promise<number>,
  page: PollPage,
  clock: PollClock,
): () => void {
  let stop = false;
  let timer: unknown;
  let inFlight = false;
  const poll = async () => {
    if (stop || inFlight) return;
    clock.clearTimeout(timer);
    let next = HIDDEN_RECHECK_MS;
    if (page.visibilityState !== "hidden") {
      inFlight = true;
      try {
        next = await ask();
      } catch {
        next = 60_000;
      } finally {
        inFlight = false;
      }
    }
    if (!stop) timer = clock.setTimeout(() => void poll(), next);
  };
  const onVisible = () => {
    if (page.visibilityState === "visible") void poll();
  };
  page.addEventListener("visibilitychange", onVisible);
  void poll();
  return () => {
    stop = true;
    clock.clearTimeout(timer);
    page.removeEventListener("visibilitychange", onVisible);
  };
}
