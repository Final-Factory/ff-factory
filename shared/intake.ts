// FFBox's intake reports grouped the way automatic investigations will group them (docs/ffbox-integration.md,
// section 6, steps 2 and 4): one item per coarse signature, the trust bar per item, and the day's numbers the
// caps apply to. Fixed code, no model: it reads only fields the connector pattern-checked. Phase 4 (automatic
// investigations) is not built yet, so nothing here starts anything; the page and ffbox_activity show the counts.
import type { IntakeBudget, IntakeGroups, IntakeSignature, ProviderIntakeEvent } from './types.ts';

/** Ben, 2026-09-27: at most 20 automatic investigations a day and 3 an hour. */
export const AUTO_PER_DAY = 20;
export const AUTO_PER_HOUR = 3;
/** More than this many new signatures in an hour trips the storm breaker. */
export const STORM_NEW_PER_HOUR = 5;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** "0.50.0.46" -> "0.50.0": the major.minor.patch series, so one fork across a day of builds stays one item. */
export function versionLine(v: string): string {
  const parts = v.trim().split('.');
  return parts.length > 3 ? parts.slice(0, 3).join('.') : v.trim() || '?';
}

/** The coarse signature: `desync:<version line>:<diverged surfaces>`; a crash has none yet, so its version line stands in. */
export function signatureOf(e: ProviderIntakeEvent): string {
  const line = versionLine(e.gameVersion);
  if (e.kind === 'crash') return `crash:${line}`;
  return `desync:${line}:${e.desync?.divergedSurfaces?.trim() || 'unknown'}`;
}

/** Group reports by signature, newest item first, and count what the caps will apply to at `now`. */
export function groupIntake(events: ProviderIntakeEvent[], now: number): IntakeGroups {
  const by = new Map<string, ProviderIntakeEvent[]>();
  for (const e of events) {
    const k = signatureOf(e);
    const list = by.get(k);
    if (list) list.push(e);
    else by.set(k, [e]);
  }
  const signatures: IntakeSignature[] = [];
  for (const [signature, list] of by) {
    const sorted = [...list].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const kind = sorted[0].kind;
    const senders = new Set(sorted.map((e) => e.sender).filter((s): s is string => !!s)).size;
    // Every peer of one desync shares its group; a report without one is its own event.
    const events = new Map<string, Set<string>>();
    for (const e of sorted) {
      const g = e.desync?.group || `report:${e.reportId}`;
      const roles = events.get(g) ?? new Set<string>();
      if (e.desync?.role) roles.add(e.desync.role);
      events.set(g, roles);
    }
    const pair = [...events.values()].some((r) => r.has('host') && r.has('client'));
    signatures.push({
      signature,
      kind,
      versionLine: versionLine(sorted[0].gameVersion),
      surfaces: kind === 'desync' ? sorted[0].desync?.divergedSurfaces?.trim() || 'unknown' : undefined,
      reports: sorted.length,
      events: events.size,
      senders,
      pair,
      trusted: kind === 'desync' && (senders >= 2 || pair),
      firstAt: sorted[sorted.length - 1].receivedAt,
      lastAt: sorted[0].receivedAt,
      versions: [...new Set(sorted.map((e) => e.gameVersion))],
      platforms: [...new Set(sorted.map((e) => e.platform))],
      reportIds: sorted.slice(0, 20).map((e) => e.reportId),
    });
  }
  signatures.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  return { signatures, budget: budgetOf(signatures, now), reports: events.length };
}

export function budgetOf(signatures: IntakeSignature[], now: number): IntakeBudget {
  const since = (iso: string, ms: number) => now - Date.parse(iso) < ms;
  const newToday = signatures.filter((s) => since(s.firstAt, DAY));
  const newLastHour = signatures.filter((s) => since(s.firstAt, HOUR)).length;
  const trustedToday = newToday.filter((s) => s.trusted).length;
  return {
    live: false,
    perDay: AUTO_PER_DAY,
    perHour: AUTO_PER_HOUR,
    newToday: newToday.length,
    newLastHour,
    trustedToday,
    wouldStartToday: Math.min(trustedToday, AUTO_PER_DAY),
    stormBreaker: { threshold: STORM_NEW_PER_HOUR, tripped: newLastHour > STORM_NEW_PER_HOUR },
  };
}
