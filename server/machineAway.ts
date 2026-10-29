/**
 * A computer away long enough that work waiting on it goes elsewhere (w2544, lothsahn, 2026-10-29: "the dispatcher should not
 * be scheduling work on offline computers--at least ones that have been offline for a few minutes or more. Make sure those
 * get moved somewhere else"). LothLaptop was paused and shut for the day while w2542's worker sat Blocked on it.
 *
 * A computer is away while its daemon is offline (since Machine.lastSeen) or it is paused (since MachinePause.since). A short
 * blip is not away for long: the grace is FF Factory's one blip window, timing.unavailableIdleMinutes (TIMED_WAIT_IDLE_MIN,
 * 5 min; Agents.timedBlip), which timed_place and the timed legs already use. Measured from the portal journal (2026-10-27
 * to 29, "machine X (dis)connected"): every drop came back within 2¼ min, most within 1 to 20 s; the longest was a portal
 * restart, 133 s (2026-10-28 09:37:26 to 09:39:39). The w2048 research (2026-10-17..24) found the same split: blips of
 * 1 to 30 s, outages of hours. 5 min is more than twice the longest blip seen.
 */
import type { MachinePause } from '../shared/types.ts';

export interface Away {
  kind: 'offline' | 'paused';
  /** Since when, epoch ms. */
  since: number;
  /** How long so far, ms. */
  ms: number;
}

export interface AwayFacts {
  online: boolean;
  /** When its daemon dropped (Machine.lastSeen), while offline. */
  offlineSince?: string;
  pause?: Pick<MachinePause, 'paused' | 'since' | 'until'>;
  /** When nothing says since when (a pause from before MachinePause.since): the earliest wait on it, epoch ms. */
  fallbackSince?: number;
}

/** Whether, and since when, a computer is away (offline or paused); undefined when it runs. */
export function awayOf(f: AwayFacts, now: number): Away | undefined {
  if (!f.online) {
    const since = Date.parse(f.offlineSince ?? '') || f.fallbackSince;
    return since === undefined ? undefined : { kind: 'offline', since, ms: Math.max(0, now - since) };
  }
  if (f.pause?.paused) {
    const since = Date.parse(f.pause.since ?? '') || f.fallbackSince;
    return since === undefined ? undefined : { kind: 'paused', since, ms: Math.max(0, now - since) };
  }
  return undefined;
}

/**
 * Whether it has been away past the grace: work waiting on it moves, and nothing new is placed there. A pause that ends by
 * itself within the grace (MachinePause.until) is a short wait, not an outage.
 */
export function longAway(a: Away | undefined, f: Pick<AwayFacts, 'pause'>, graceMs: number, now: number): a is Away {
  if (!a || a.ms < graceMs) return false;
  if (a.kind === 'paused' && f.pause?.until) {
    const until = Date.parse(f.pause.until);
    if (Number.isFinite(until) && until - now < graceMs) return false;
  }
  return true;
}

/** "lothlaptop (offline 6 min)", as the request's log and its moved worker read it. */
export function awayLine(id: string, a: Away): string {
  const min = Math.round(a.ms / 60_000);
  return `${id} (${a.kind} ${min < 1 ? 'under a minute' : `${min} min`})`;
}

/** Whether a request's own words or pin keep it on `machine` (w2544): a brief that names the machine explicitly waits for it. */
export function namesMachine(pinIds: readonly string[] | undefined, machine: string): boolean {
  const m = machine.toLowerCase();
  return !!pinIds?.some((id) => id.toLowerCase() === m);
}

/** The first lines of a session that took work off a computer away past the grace (w2544), before the request and handover. */
export function awayLead(m: { ids: string; first: string; worker: string; from: string; machine: string; line: string; kind: Away['kind']; graceMin: number; to: string; why: string; branch?: string; lost: string; timedLeg?: boolean }): string {
  const lines = [
    `[moved, w2544] FF Factory moved ${m.ids} to this computer: its worker ${m.worker} on ${m.from} waited for ${m.line}, past the ${m.graceMin} min grace (lothsahn: "the dispatcher should not be scheduling work on offline computers ... Make sure those get moved somewhere else"). ${m.to} had room (${m.why}). That worker is stopped and its sandbox released; you carry ${m.first} on from where it left off.`,
    m.kind === 'offline'
      ? `What may be lost: ${m.lost}. ${m.machine} is offline, so nothing in its sandbox can be fetched: start from the pushed branch ${m.branch ?? '(unknown: its branch was never reported), and from the brief and last report below'}, and redo whatever its worker had not pushed.`
      : `What may be lost: ${m.lost}. ${m.machine} is paused but its daemon may still run: FF Factory tried to save and push its sandbox's uncommitted work as a WIP commit on ${m.branch ?? 'its branch'} (the handover says whether it did).`,
  ];
  if (m.timedLeg) lines.push('A timed leg moved: numbers from two computers do not compare, so build and time both its sides again here.');
  return lines.join('\n');
}
