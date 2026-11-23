// When the page's live socket (web/src/api.ts connectSocket) gives up on an attempt and tries again (w5318).
// lothsahn's page went 14 min without a live connection on 2026-11-23 (18:53:06 to 19:07:17Z) while the portal and
// the orchestrator answered within seconds: Tailscale Funnel was failing (layer 9, from 18:52Z and 18:59Z), and an
// attempt through it can hang with no close event. The page only replaced a socket that was open and silent, never one
// still connecting, and a tab coming back did nothing while one was in flight, so one hung attempt held the page dark.

/** An attempt not open by then is abandoned and tried again: a healthy open, Funnel included, takes well under a second. */
export const SOCKET_CONNECT_TIMEOUT_MS = 10_000;
/** The state fetch a failed attempt makes (is this login still good?) gives up after this: it carries the whole state. */
export const SOCKET_FAILURE_CHECK_MS = 30_000;
/** The longest wait between attempts. */
export const SOCKET_MAX_BACKOFF_MS = 15_000;

/** The wait before attempt `attempt` (0 first), with `rand` in [0, 1) for a ±25% jitter. */
export function socketBackoffMs(attempt: number, rand: number): number {
  return Math.min(SOCKET_MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 30)) * (0.75 + rand * 0.5);
}

export interface SocketLook {
  /** The browser's readyState as a word: an attempt in flight, an open socket, or none (closing or closed). */
  state: 'connecting' | 'open' | 'none';
  /** When this attempt started (ms). */
  startedAt: number;
  /** When the open socket last delivered anything, the server's ping included (ms). */
  heard: number;
  now: number;
  /** Silence after which an open socket counts as dead (SOCKET_STALE_MS). */
  staleMs: number;
}

/**
 * keep, or replace it now: `stale` an open socket that went silent, `timeout` an attempt still connecting past
 * SOCKET_CONNECT_TIMEOUT_MS (it hung: the path took the connection and passes nothing back).
 */
export function socketVerdict(s: SocketLook): 'keep' | 'stale' | 'timeout' {
  if (s.state === 'open') return s.now - s.heard >= s.staleMs ? 'stale' : 'keep';
  if (s.state === 'connecting') return s.now - s.startedAt >= SOCKET_CONNECT_TIMEOUT_MS ? 'timeout' : 'keep';
  return 'keep';
}
