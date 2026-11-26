// A person's drain of a machine (w5878): "Hold new work on LothDesktop and let the running workers finish" (lothsahn,
// w5814). Before it, such a hold lived only in the dispatcher's notes, and the automatic moves (w2046) put four requests on
// LothDesktop in two hours (w5838, w5857, w5863, w5834), since every placement path reads holds from Agents.placement()
// and nothing there knew. A drain is kept on the machine's record and merged into placement() beside a coming build's
// and a person's game's holds: no new work, move or pair leg goes there, and the workers already there resume and finish
// (machineHold reads placement(false), which leaves it out).
import type { Machine, MachineDrain } from '../shared/types.ts';

/** The drain in force on `m`, or undefined (none, or past its `until`). */
export function drainOf(m: Pick<Machine, 'drain'> | undefined, now = Date.now()): MachineDrain | undefined {
  const d = m?.drain;
  if (!d) return undefined;
  if (d.until && Date.parse(d.until) <= now) return undefined;
  return d;
}

/** Why `m` takes no new work: the hold text placement.hold carries for it (placement.ts holdReason prefixes the machine). */
export function drainHold(d: MachineDrain): string {
  return `drained: ${d.who}: "${d.words}" (set by ${d.by} at ${d.at.slice(11, 16)}Z${d.until ? `, until ${d.until.slice(0, 16).replace('T', ' ')}Z` : ''}; w5878)`;
}

/** Every drained machine's hold, for Agents.placement(). */
export function drainHolds(machines: Iterable<Pick<Machine, 'id' | 'drain'>>, now = Date.now()): { hold: Record<string, string>; except: Record<string, string[]> } {
  const hold: Record<string, string> = {};
  const except: Record<string, string[]> = {};
  for (const m of machines) {
    const d = drainOf(m, now);
    if (!d) continue;
    hold[m.id] = drainHold(d);
    if (d.except?.length) except[m.id] = d.except;
  }
  return { hold, except };
}

/** A drain from hold_machine's arguments, or why not. */
export function newDrain(a: { words?: string; who?: string; hours?: number; except?: string[] }, by: string, now: Date): MachineDrain | string {
  const words = (a.words ?? '').trim().replace(/\s+/g, ' ');
  const who = (a.who ?? '').trim();
  if (words.length < 8) return "words: the person's own words asking for the hold, quoted (at least a few words): a drain is a person's, never the dispatcher's own idea";
  if (!who) return 'who: the person who said them';
  const until = a.hours ? new Date(now.getTime() + a.hours * 3_600_000).toISOString() : undefined;
  const except = a.except?.map((x) => x.trim().toLowerCase()).filter((x) => /^w\d+$/.test(x));
  return { words: words.slice(0, 300), who: who.slice(0, 60), by, at: now.toISOString(), ...(until ? { until } : {}), ...(except?.length ? { except } : {}) };
}
