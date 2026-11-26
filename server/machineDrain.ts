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
export function newDrain(a: { words?: string; who?: string; hours?: number; except?: string[]; resumes?: 'running' | 'all'; running?: readonly string[] }, by: string, now: Date): MachineDrain | string {
  const words = (a.words ?? '').trim().replace(/\s+/g, ' ');
  const who = (a.who ?? '').trim();
  if (words.length < 8) return "words: the person's own words asking for the hold, quoted (at least a few words): a drain is a person's, never the dispatcher's own idea";
  if (!who) return 'who: the person who said them';
  const until = a.hours ? new Date(now.getTime() + a.hours * 3_600_000).toISOString() : undefined;
  const except = a.except?.map((x) => x.trim().toLowerCase()).filter((x) => /^w\d+$/.test(x));
  const resumes = a.resumes ?? 'running';
  return { words: words.slice(0, 300), who: who.slice(0, 60), by, at: now.toISOString(), ...(until ? { until } : {}), ...(except?.length ? { except } : {}), resumes, ...(resumes === 'running' ? { running: [...(a.running ?? [])] } : {}) };
}

/** A worker on a held machine, as the read-back sees it live (w5895). */
export interface HeldWorker {
  id: string;
  /** Mid-turn now (its process runs a turn). */
  midTurn: boolean;
  /** Its process is stopped (a message or its check-in starts it again). */
  stopped: boolean;
  /** Its open requests (lower case). */
  works: string[];
  /** Its pending check-in (wake_me), ISO. */
  wake?: string;
}

const hhmm = (iso: string) => `${iso.slice(11, 16)}Z`;
const nextResume = (s: HeldWorker) => (s.wake ? `will resume here at its check-in ${hhmm(s.wake)}` : 'resumes here at its next message');

/**
 * w5895: why a drain set to let only its running workers resume (resumes 'running') would hold this worker's resume, or
 * undefined. Warn-only for now: machineHold logs it and lets the resume go (a hold that strands work is lothsahn's lockout).
 */
export function drainWouldHold(d: MachineDrain | undefined, s: Pick<HeldWorker, 'id' | 'works'>): string | undefined {
  if (!d || d.resumes !== 'running') return undefined;
  if (d.running?.includes(s.id)) return undefined;
  if (s.works.some((w) => d.except?.includes(w))) return undefined;
  return `${d.who}'s drain lets only the workers running at ${hhmm(d.at)} finish ("${d.words}")`;
}

/**
 * w5895: the live state of a machine's hold, read back after every hold or setting change (lothsahn: "Maybe have a tool to
 * double check the status when you change settings and make sure you double check"): held or NOT held, and every excepted
 * request with no worker running there (w5475, w5586, w5656, w5796 were stopped and resumed during the 03:47 hold), and
 * every worker a drain lets resume. `hold`: placement()'s hold of it (undefined: none); `except`: the requests let through.
 */
export function holdReadback(name: string, hold: string | undefined, except: readonly string[], drain: MachineDrain | undefined, workers: readonly HeldWorker[]): string {
  if (!hold) return `${name}: NOT held (no hold or drain in force there: new work and resumes go there as usual).`;
  const lines = [`${name}: HELD (${hold})${except.length ? `, except ${except.join(', ')}` : ''}.`];
  const live = workers.filter((s) => !s.stopped);
  for (const id of except) {
    const mine = workers.filter((s) => s.works.includes(id));
    if (!mine.length) lines.push(`  ${id}: no worker of it here; a new one may start here (the hold lets it through).`);
    for (const s of mine) {
      if (s.midTurn) lines.push(`  ${id}: worker ${s.id} running.`);
      else lines.push(`  ${id}: worker ${s.id} ${s.stopped ? 'stopped' : 'between turns'}; ${nextResume(s)} (the hold lets it through).`);
    }
  }
  if (drain) {
    // A drain lets the workers already there resume (placement(false)); 'running' would hold the rest, once enforced.
    for (const s of workers.filter((x) => !x.midTurn && !x.works.some((w) => except.includes(w)))) {
      const would = drainWouldHold(drain, s);
      lines.push(`  worker ${s.id}${s.works.length ? ` (${s.works.join(', ')})` : ''} ${s.stopped ? 'stopped' : 'between turns'}; ${nextResume(s)}${would ? ': the drain lets only its running workers finish, so this resume is AGAINST it (warn-only until enforced, w5895)' : ' (a drain lets its own workers resume)'}.`);
    }
  } else if (live.length) {
    lines.push(`  ${live.filter((s) => s.midTurn).length} worker(s) mid-turn there finish their turn; the others' resumes wait for the lift.`);
  }
  return lines.join('\n');
}
