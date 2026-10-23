// A person playing Final Factory on this computer (w1894, docs/unity-lifecycle.md "A person's game"). The request's goal
// (lothsahn, "Please file all of w1785s ranked list", its item 1): while lothsahn plays Final Factory on LothDesktop, FF
// Factory's agents there stop taking the game's CPU, and resume after. On LothDesktop one release build ran at 27.4 fps
// quiet and 12 to 15 fps while agents' players, editors and builds held 7.5 to 11.3 of its 16 threads (measured by w1785).
//
// How a person is told from an agent: the leftovers' look (machine/leftovers.ts) sees every game player each minute and
// knows the workers' ones: FF_SESSION_ID in its environment (every worker shell and what it starts carries it), a player slot lease
// for its pid (player_slots.py launch), a command line naming a worker's temp folder or a sandbox (a build an agent runs
// from there, a sandbox editor's Build And Run). A game player with none of them is a person's: Steam's launch of the game,
// or a build a person starts by hand. The game window in front was weighed and not used: a person alt-tabs to a guide or Discord while
// the game runs and still wants its frames, and an agent's player in front would count as theirs.
//
// What happens then is the exclusive turn's (machine/benchTurn.ts, w1829) with a person's game as its holder: the other
// sandboxes' editors close (saved first), the workers' players are asked to quit, batch Unity runs drop to idle priority and
// finish (never ended: they hold their shared tickets rightfully), new editor starts, Unity runs, players, clips and timed
// legs wait, and the portal places nothing new there. A grace period after the game closes (GRACE_MIN) covers a restart of
// the game, then everything comes back as after a timed run.
//
// The state is kept in <root>/tmp/bench.queue/person.json, written at every look: the guard and unity-slot read it to hold
// new work (personHoldReason), and a daemon restart keeps a game seen just before it until its first look. A file the daemon
// stopped writing (STALE_MS) holds nothing, so a daemon that is gone never keeps work waiting.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Proc } from './unity.ts';

/** The portal's machines.personPlay for this machine (sent with the bench priorities each minute). */
export interface PersonPlaySettings {
  enabled: boolean;
  /** Minutes after the game closes before the agents' work comes back. */
  graceMinutes: number;
  /** Who plays there, for the messages ("lothsahn"); absent: "someone". */
  who?: string;
}

/**
 * After the game closes, how long the agents still yield. A guess: a restart of the game (a crash, a settings change, quitting
 * to the desktop to load another save) takes a minute or two, and each turn's end reopens every closed editor, which takes
 * minutes of CPU of its own; ten minutes keeps one restart from costing the player two rounds of it.
 */
export const GRACE_MIN = 10;
/** A person.json not written for this long holds nothing: the daemon that wrote it stopped looking (gone, or the look is off). */
export const STALE_MS = 5 * 60_000;

/** What the daemon reports and writes: who plays, the game's pids, since when, and when the grace ends once it closed. */
export interface PersonPlayState {
  who: string;
  pids: number[];
  /** When the game was first seen (epoch ms); also the turn's id. */
  since: number;
  /** When it was last seen running. */
  lastSeen: number;
  /** Once it closed: when the grace ends and work comes back. */
  until?: number;
}

export const personFile = (root: string) => path.join(root, 'tmp', 'bench.queue', 'person.json');

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + 'Z';

/** "lothsahn playing Final Factory on this PC": the holder's words in the turn's messages. */
export const personHolderText = (who: string) => `${who} playing Final Factory on this PC`;

/** The ticket name a person's turn goes by (benchClosed marks, closed.json): one per game seen. */
export const personTicket = (since: number) => `person:${since}`;
export const isPersonTicket = (ticket: string | undefined) => !!ticket?.startsWith('person:');

/** When the turn ends, for people: "10 min after the game closes", or "at 18:52Z" once it closed. */
export function personEnds(s: Pick<PersonPlayState, 'until'>, graceMinutes: number): string {
  return s.until ? `at ${hhmm(s.until)} (the game closed; ${graceMinutes} min of grace)` : `${graceMinutes} min after the game closes`;
}

/** The refusal for new work while a person plays: what waits, why and until when. */
export function personHoldText(s: PersonPlayState, graceMinutes: number): string {
  return `${s.who} is playing Final Factory on this PC (game pid ${s.pids.join(', ') || '?'}, since ${hhmm(s.since)}; w1894: agents yield while a person plays here); work resumes ${personEnds(s, graceMinutes)}`;
}

export interface PersonPlayDeps {
  root?: string;
  settings(): PersonPlaySettings;
  now(): number;
  log(text: string): void;
}

/** The person's-game watch: fed each leftovers look, read by the turn, the stats and the file. */
export class PersonPlay {
  private readonly d: PersonPlayDeps;
  private s?: PersonPlayState;
  private written?: string;

  constructor(d: PersonPlayDeps) {
    this.d = d;
    // A game seen just before a restart holds until the first look says otherwise (a fresh file only).
    const kept = d.root ? readPersonFile(d.root, d.now()) : undefined;
    if (kept) this.s = kept.state;
  }

  /** The state now: playing, or in the grace after the game closed; undefined when nobody plays (or it is off here). */
  state(): PersonPlayState | undefined {
    const set = this.d.settings();
    if (!set.enabled || !this.s) return undefined;
    if (this.s.until !== undefined && this.d.now() >= this.s.until) return undefined;
    return this.s;
  }

  /** One look's verdict: the pids of the game players no worker started (machine/leftovers.ts persons). */
  seen(pids: number[]): void {
    const set = this.d.settings();
    const now = this.d.now();
    const who = set.who || 'someone';
    if (!set.enabled) {
      if (this.s) this.d.log(`person play: off on this machine now (machines.personPlay.enabled): the agents' work is no longer held for ${this.s.who}`);
      this.s = undefined;
    } else if (pids.length) {
      if (!this.s || this.s.until !== undefined && now >= this.s.until) {
        this.s = { who, pids, since: now, lastSeen: now };
        this.d.log(`person play: ${who}'s game runs (pid ${pids.join(', ')}): agents yield on this PC until ${set.graceMinutes} min after it closes`);
      } else {
        if (this.s.until !== undefined) this.d.log(`person play: ${who}'s game runs again (pid ${pids.join(', ')}) within the grace: the agents keep yielding`);
        this.s = { ...this.s, who, pids, lastSeen: now, until: undefined };
      }
    } else if (this.s) {
      if (this.s.until === undefined) {
        this.s = { ...this.s, pids: [], until: now + set.graceMinutes * 60_000 };
        this.d.log(`person play: ${this.s.who}'s game closed: agents' work resumes at ${hhmm(this.s.until!)} unless it starts again`);
      } else if (now >= this.s.until) {
        this.d.log(`person play: the grace after ${this.s.who}'s game ended: agents' work resumes`);
        this.s = undefined;
      }
    }
    this.write();
  }

  private write() {
    const root = this.d.root;
    if (!root) return;
    const st = this.state();
    const body = st ? { ...st, graceMinutes: this.d.settings().graceMinutes } : {};
    const j = JSON.stringify(body);
    // Written at every look (its `at` is the freshness the readers check), but logged only when it changes.
    const file = personFile(root);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: this.d.now(), ...body }));
      fs.renameSync(tmp, file);
      this.written = j;
    } catch (e) {
      if (this.written !== j) this.d.log(`person play: could not write ${file}: ${(e as Error).message}`);
    }
  }
}

/** person.json while it holds: fresh (STALE_MS) and someone plays or the grace runs; undefined otherwise. */
export function readPersonFile(root: string, now: number = Date.now()): { state: PersonPlayState; graceMinutes: number } | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(personFile(root), 'utf8')) as Partial<PersonPlayState> & { at?: number; graceMinutes?: number };
    if (typeof j.at !== 'number' || now - j.at > STALE_MS || typeof j.since !== 'number' || typeof j.who !== 'string') return undefined;
    if (typeof j.until === 'number' && now >= j.until) return undefined;
    const state: PersonPlayState = { who: j.who, pids: Array.isArray(j.pids) ? j.pids.filter((p) => Number.isInteger(p)) : [], since: j.since, lastSeen: typeof j.lastSeen === 'number' ? j.lastSeen : j.since, ...(typeof j.until === 'number' ? { until: j.until } : {}) };
    return { state, graceMinutes: typeof j.graceMinutes === 'number' ? j.graceMinutes : GRACE_MIN };
  } catch {
    return undefined;
  }
}

/** Why new work waits while a person plays here (the guard's players and clips, unity-slot run), or undefined. */
export function personHoldReason(root: string | undefined, now: number = Date.now()): string | undefined {
  if (!root) return undefined;
  const f = readPersonFile(root, now);
  return f ? personHoldText(f.state, f.graceMinutes) : undefined;
}

/** `root` and every process under it in a listing (by parent pids), root first. */
export function treeOf(root: number, procs: Pick<Proc, 'pid' | 'ppid'>[]): number[] {
  const out = [root];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i++) for (const p of procs) if (p.ppid === out[i] && !seen.has(p.pid)) (seen.add(p.pid), out.push(p.pid));
  return out;
}

/** A process's CPU priority (os.getPriority: 19 is Windows' idle class), or undefined when it is gone or not ours to read. */
export function priorityOf(pid: number): number | undefined {
  try {
    return os.getPriority(pid);
  } catch {
    return undefined;
  }
}

/** Set a process's CPU priority (Windows: PRIORITY_LOW is the idle class, which the processes it starts inherit); false when it cannot. */
export function setPriorityOf(pid: number, priority: number): boolean {
  try {
    os.setPriority(pid, priority);
    return true;
  } catch {
    return false;
  }
}
