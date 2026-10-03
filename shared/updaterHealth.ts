// FFBox's self-updater, as its connector pushes it (docs/ffbox-connector-contract.md, "updater"): whether updates
// are landing. The red/green rule the sidebar, the FFBox page, system_status and ffbox_activity all use, worked out
// the same way on the server and in the page (w265: "if updates are failing, it has a red dot").
import type { ProviderUpdater, ProviderUpdaterCheckout } from './types.ts';

/** A pass is due every interval (FFBox's timer, 3 min); none finished or started for this many intervals is a stalled updater. */
export const UPDATER_STALE_INTERVALS = 3;
/** When the connector does not say its interval. */
export const UPDATER_DEFAULT_INTERVAL_S = 180;

export interface UpdaterHealth {
  /** ok: every checkout current. failing: a checkout FFBox reports not ok. stale: no pass for UPDATER_STALE_INTERVALS intervals. */
  state: 'ok' | 'failing' | 'stale';
  /** The checkouts that are not ok (empty when ok or only stale). */
  failing: ProviderUpdaterCheckout[];
  /** Since when it has not been ok: the oldest failing checkout's `since`, or the last pass for a stale updater. */
  since?: string;
  /** One line: "FFBox updates failing: agents diverged from origin/master; ..., since 2026-10-03 17:00 UTC". */
  line: string;
}

/** "2026-10-03 17:00 UTC": short enough for a line, and the same wherever the line is read. */
export const utcMinute = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 'an unknown time' : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

/** The updater's latest sign of life: the last pass's end, or a pass's start after it. */
export function updaterLastActivity(u: ProviderUpdater): number {
  const at = Date.parse(u.at);
  const running = u.runningSince ? Date.parse(u.runningSince) : NaN;
  return Math.max(Number.isNaN(at) ? 0 : at, Number.isNaN(running) ? 0 : running);
}

const reason = (c: ProviderUpdaterCheckout) => c.message || c.status;

/** undefined when FFBox has never sent one (a connector from before w265): nothing is known, so nothing is said. */
export function updaterHealth(u: ProviderUpdater | undefined, now: number): UpdaterHealth | undefined {
  if (!u) return undefined;
  const intervalMs = (u.intervalSecs && u.intervalSecs > 0 ? u.intervalSecs : UPDATER_DEFAULT_INTERVAL_S) * 1000;
  const last = updaterLastActivity(u);
  const failing = u.checkouts.filter((c) => !c.ok);
  if (now - last > UPDATER_STALE_INTERVALS * intervalMs) {
    const since = last ? new Date(last).toISOString() : undefined;
    return { state: 'stale', failing, since, line: `FFBox updates failing: the updater has not run a pass since ${utcMinute(since)} (due every ${Math.round(intervalMs / 60_000)} min)` };
  }
  if (failing.length || !u.ok) {
    const sinces = failing.map((c) => c.since).filter((s): s is string => !!s && !Number.isNaN(Date.parse(s)));
    const since = sinces.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? u.since;
    const what = failing.length ? failing.map((c) => `${c.name} ${reason(c)}`).join('; ') : 'the updater reports a problem';
    return { state: 'failing', failing, since, line: `FFBox updates failing: ${what}, since ${utcMinute(since)}` };
  }
  return { state: 'ok', failing: [], since: u.since, line: `FFBox updates ok: ${u.checkouts.map((c) => `${c.name} ${c.status}`).join(', ') || 'no checkouts reported'}; last pass ${utcMinute(u.at)}` };
}
