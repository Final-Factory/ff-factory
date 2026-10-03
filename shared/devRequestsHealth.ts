// Whether FFBox operators' dev requests are reaching this portal (w266). FFBox's `status` answer carries a
// `dev_requests` block (docs/ffbox-connector-contract.md, "status"): its operators' ffdev turns of the last 24 hours,
// handed over, taken, fallen back (run on FFBox instead) or skipped by design. A fallback is a failure nobody would
// otherwise see: on 2026-10-03 two of Lothsahn's turns ran on FFBox and this portal's dev request view said "0 in 24 h".
import type { ProviderDevRequests } from './types.ts';

export type DevRequestsHealthState = 'ok' | 'failing' | 'off' | 'unknown';

/** The health and, when it is not ok, one line saying why. Pure: the sidebar, the panel and system_status share it. */
export function devRequestsHealth(d: ProviderDevRequests | undefined): { state: DevRequestsHealthState; line?: string; short?: string } {
  if (!d) return { state: 'unknown' };
  if (d.mode === 'off') return { state: 'off', line: 'FFBox dev requests are off (its fff.dev_requests): operators’ turns run on FFBox' };
  if (d.ok) return { state: 'ok' };
  const f = d.lastFallback ?? {};
  const turn = f.conversation !== undefined ? `conversation ${f.conversation}${f.turn !== undefined ? ` (turn ${f.turn})` : ''}` : 'an operator’s turn';
  const why = f.error ?? 'no reason given';
  const count = d.fallback !== undefined ? `; ${d.fallback} in ${d.windowHours ?? 24} h` : '';
  return {
    state: 'failing',
    line: `FFBox dev requests falling back: ${turn} ran on FFBox instead of coming here (${why})${f.at ? ` at ${f.at}` : ''}${count}`,
    short: `${f.conversation !== undefined ? `conv ${f.conversation}: ` : ''}${why}`,
  };
}
