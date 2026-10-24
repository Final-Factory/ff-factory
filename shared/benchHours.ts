// What exclusive bench tickets cost a machine, per UTC hour (w1996; lothsahn: "We're wasting system resources like crazy
// locking beast down to a single timing job"). The daemon computes the rows from the bench queue's own history
// (machine/benchHours.ts) and sends them as `bench_hours`; the portal keeps them (server/benchHoursStore.ts) and
// portal_logs reads them (source bench_hours). This file is what both sides share.

/** One UTC hour of one machine's bench queue. Whole seconds. */
export interface BenchHourRow {
  /** The hour's start, ISO: "2026-10-24T05:00:00Z". */
  hour: string;
  /** Seconds an exclusive ticket was granted (held) within the hour. */
  exclusiveS: number;
  /** Exclusive holds that overlap the hour. */
  holds: number;
  /**
   * For each hold: its seconds in the hour times the number of OTHER sandboxes that had a shared ticket alive (taken, not
   * yet ended) at some point during the hold. A lower bound of the editor slots the turn idled: since w1860 every running
   * editor holds a shared ticket.
   */
  idleSlotS: number;
  /** Seconds other sessions' shared tickets spent waiting (take to grant) while an exclusive one was granted, within the hour. */
  sharedWaitS: number;
  /** Seconds any shared ticket was granted within the hour (the union, not the sum). */
  sharedS: number;
  /** Request ids joined by "," ("-": none) -> exclusive seconds within the hour. */
  byRequest: Record<string, number>;
}

/** Hours the daemon sends (the last 72 h), and the request entries it keeps per hour. */
export const BENCH_HOURS_MAX_ROWS = 72;
export const BENCH_HOURS_MAX_REQUESTS = 10;
/** How long the portal keeps an hour. */
export const BENCH_HOURS_KEEP_DAYS = 14;

export const HOUR_MS = 3_600_000;

/** The ISO hour start (no milliseconds) of the hour that holds `ms`. */
export const hourStartIso = (ms: number) => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().replace(/\.\d+Z$/, 'Z');

const HOUR_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/;
const count = (v: unknown, max = 1e9) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : undefined);

/**
 * The rows of a `bench_hours` message the portal accepts: a bad row is dropped, never fixed, at most BENCH_HOURS_MAX_ROWS
 * rows and BENCH_HOURS_MAX_REQUESTS request entries (the biggest) a row, request ids of a safe shape only. A daemon's
 * text is data: nothing else of a row survives.
 */
export function sanitizeBenchRows(rows: unknown): BenchHourRow[] {
  if (!Array.isArray(rows)) return [];
  const out: BenchHourRow[] = [];
  for (const r of rows.slice(0, BENCH_HOURS_MAX_ROWS)) {
    if (!r || typeof r !== 'object' || typeof r.hour !== 'string' || !HOUR_ISO.test(r.hour) || Number.isNaN(Date.parse(r.hour))) continue;
    const exclusiveS = count(r.exclusiveS, HOUR_MS / 1000);
    const holds = count(r.holds, 1e6);
    const idleSlotS = count(r.idleSlotS, 1e9);
    const sharedWaitS = count(r.sharedWaitS, 1e9);
    const sharedS = count(r.sharedS, HOUR_MS / 1000);
    if (exclusiveS === undefined || holds === undefined || idleSlotS === undefined || sharedWaitS === undefined || sharedS === undefined) continue;
    const byRequest: Record<string, number> = {};
    const entries = r.byRequest && typeof r.byRequest === 'object' ? Object.entries(r.byRequest as Record<string, unknown>) : [];
    const kept = entries
      .filter(([k]) => /^[A-Za-z0-9][A-Za-z0-9._,-]{0,80}$|^-$/.test(k))
      .flatMap(([k, v]): [string, number][] => {
        const n = count(v, HOUR_MS / 1000);
        return n === undefined ? [] : [[k, n]];
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, BENCH_HOURS_MAX_REQUESTS);
    for (const [k, v] of kept) byRequest[k] = v;
    out.push({ hour: r.hour, exclusiveS, holds, idleSlotS, sharedWaitS, sharedS, byRequest });
  }
  return out;
}
