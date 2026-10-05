// FFBox's intake reports grouped by coarse signature for reading (docs/ffbox-integration.md, section 6, step 2): one
// item per signature and the trust bar per item. Fixed code, no model: it reads only fields the connector
// pattern-checked, and starts nothing. FFBox diagnoses the reports itself, per report and per play session (its
// intake.auto, since 2026-10-04); what it did is ffbox_activity show "signatures" (server/ffboxAutoIntake.ts).
import type { IntakeGroups, IntakeSignature, ProviderIntakeEvent } from './types.ts';

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

/** Group reports by signature, newest item first. */
export function groupIntake(events: ProviderIntakeEvent[]): IntakeGroups {
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
  return { signatures, reports: events.length };
}
