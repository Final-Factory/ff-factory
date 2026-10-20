// Builds first on BEAST (w1606, docs/orchestrators.md "Builds clear BEAST"). Ben, 2026-10-20: "i want to make it so, when you
// know builds are coming up, we also prioritize using beast for builds because its faster. so when it's coming time, move
// work off beast, or when apropriate, pause work and finish the build, then resume. make this a rule of FFF".
//
// A worker (or the dispatcher, for a request) declares a build coming on a build computer (placement.build, DEFAULT_BUILD:
// beast) with a rough lead time, through the build_plan tool. Then:
// - From the declaration, the computer is held for new work (Agents.placement() adds holds()): nothing new is placed there,
//   no released worker resumes there, nothing is moved there. Its workers go on as they are until the build is due.
// - When it is due, FF Factory clears it (clear()). Each other worker there:
//   - one whose Live view runs is left alone: a Live view a person may be steering beats a build, and a move ends the view
//     (the build runs beside it, a little slower);
//   - one between turns is moved (Agents.moveWorker, the w1600 route: process stopped, work saved and pushed, its requests
//     Queued for the other computer with their branch) to the computer the general placement picks, when one has room;
//     when none has, it is paused in place: its resumes (a check-in, CI, a reply) wait in the send queue (resumeHold) until
//     the build is done, and then go;
//   - one mid-turn is asked to finish its step, commit and push, stop its editor and end its turn (pauseNotice): never cut
//     off. Once its turn ends it is paused the same way, and when the build is done FF Factory resumes it (done()).
// - The build starts when its worker asks (build_plan start) and the computer is clear: refused while the computer's bench
//   lock is held (a timed run's numbers, w1440: never overridden), and while a worker asked to pause is still mid-turn, up to
//   BUILD_WAIT_MS after the clearing began; past that the build goes ahead beside it, said so.
// - build_plan done (or PLAN_MAX_MS past due, or its builder's requests all closed) ends it: the hold lifts, the queued
//   resumes go, and each worker paused mid-turn is told to carry on.
import type { BenchLock, SessionInfo, WorkItem } from '../shared/types.ts';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';
import { benchText } from './placement.ts';

/** How long a build waits for workers asked to pause to end their turns before it goes ahead beside them. */
export const BUILD_WAIT_MS = { value: 20 * 60_000 };
/** A plan not ended this long after it was due is ended by itself (a release build and its tests take under two hours). */
export const PLAN_MAX_MS = { value: 3 * 60 * 60_000 };
/** The longest lead time a declaration takes. */
export const MAX_LEAD_MIN = 240;

export interface BuildPlan {
  machine: string;
  what: string;
  /** The worker that runs the build (its own turns go on); absent when the dispatcher declared it for `requests`. */
  builder?: string;
  /** The requests it serves: a worker serving one of them is the builder too. */
  requests: string[];
  /** "worker 0ab3640a" or "the dispatcher". */
  by: string;
  declaredAt: number;
  dueAt: number;
  /** When FF Factory cleared the computer (at due, or at an earlier start). */
  clearedAt?: number;
  startedAt?: number;
  /** Workers asked to pause mid-turn: session id to when. Paused once their turn ends. */
  told: Record<string, number>;
  /** Workers whose resumes wait for the build (between turns at the clearing, or told and since ended). */
  paused: string[];
  moved: { session: string; to: string; requests: string[] }[];
  /** Workers left alone, with why ("its Live view runs"). */
  kept: { session: string; why: string }[];
}

export interface BuildDeps {
  /** The build computers in order (placement.build, else DEFAULT_BUILD). */
  buildMachines: () => string[];
  workersOn: (machineId: string) => SessionInfo[];
  isLive: (id: string) => boolean;
  isMidTurn: (info: SessionInfo) => boolean;
  openRequestsOf: (sessionId: string) => WorkItem[];
  /** Its Live view runs now (a person may be steering it). */
  hasView: (sessionId: string) => boolean;
  benchLock: (machineId: string) => BenchLock | undefined;
  /** Another computer with room for this worker's work (the general placement, never `from`), or undefined. */
  moveTarget: (info: SessionInfo, from: string) => string | undefined;
  /** Agents.moveWorker: resolves with its answer, throws with why not. */
  move: (sessionId: string, to: string, why: string) => Promise<string>;
  /** A system message into a worker's turn (or the next one). */
  tell: (sessionId: string, text: string) => void;
  /** The dispatcher's [ledger] line. */
  notify: (text: string) => void;
  /** The send queue looks again (a resume held for the build may go now). */
  kick?: () => void;
  /** Mark a request as build work (WorkItem.build) the first time. */
  markBuild?: (w: WorkItem, sessionId: string, machineId: string) => void;
  log: (line: string) => void;
  now?: () => number;
  file?: string;
}

const hhmm = (t: number) => `${new Date(t).toISOString().slice(11, 16)}Z`;
const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000));
/** Every worker the build paused: between turns at the clearing, or asked mid-turn (paused once its turn ends). */
const pausedOf = (p: BuildPlan) => [...new Set([...p.paused, ...Object.keys(p.told)])];
/** The ones paused between turns, which resume with their own next message. */
const idleOf = (p: BuildPlan) => p.paused.filter((id) => p.told[id] === undefined);

/** What a worker mid-turn on a computer being cleared for a build is told (once). */
export function pauseNotice(p: Pick<BuildPlan, 'machine' | 'what' | 'by'>, requests: readonly string[]): string {
  const example = requests[0] ?? 'wNNN';
  return [
    `[FF Factory] BUILD (w1606): ${p.by} builds ${p.what} on ${p.machine} now, and builds run there alone, so FF Factory pauses the other work on it. You are not stopped and lose nothing:`,
    '1. Finish the step you are on and start no new one. Commit what is unfinished on your branch (a WIP commit is fine) and push it.',
    "2. Stop your sandbox's Unity editor (mcp__machine__unity stop) and any player or batch run you started, unless a person is watching your Live view now.",
    `3. End your turn with one line per request: \`${example}: paused for the build on ${p.machine}; <where you stopped>\`. Set no wake_me for it.`,
    `Your check-ins and replies wait meanwhile, and when the build is done FF Factory tells you to carry on, in this same conversation and sandbox. If \`build_plan status\` says no build is planned on ${p.machine}, it is over: ignore this and carry on.`,
  ].join('\n');
}

export class BuildPlans {
  private readonly d: BuildDeps;
  private readonly now: () => number;
  private readonly plans = new Map<string, BuildPlan>();
  private clearing = new Set<string>();

  constructor(d: BuildDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  // ---------------------------------------------------------------- reading

  plan(machineId: string | undefined): BuildPlan | undefined {
    return machineId ? this.plans.get(machineId.toLowerCase()) : undefined;
  }

  all(): BuildPlan[] {
    return [...this.plans.values()];
  }

  private isBuilder(p: BuildPlan, sessionId: string): boolean {
    if (p.builder === sessionId) return true;
    return p.requests.length > 0 && this.d.openRequestsOf(sessionId).some((w) => p.requests.includes(w.id));
  }

  /** The hold of each computer a build is coming to or running on, for Agents.placement(): no new work goes there. */
  holds(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.plans.values()) out[p.machine] = this.holdWhy(p);
    return out;
  }

  private holdWhy(p: BuildPlan): string {
    const state = p.startedAt ? `building since ${hhmm(p.startedAt)}` : p.clearedAt ? `cleared for a build since ${hhmm(p.clearedAt)}` : `a build is coming at ${hhmm(p.dueAt)}`;
    return `${state} (${p.what}, ${p.by}${p.requests.length ? ` for ${p.requests.join(', ')}` : ''}; w1606): no new work until it is done`;
  }

  /**
   * Why a message to this worker waits (Agents.machineHold), or undefined: it was paused for a build that runs or is being
   * cleared for. Not its builder, and not a worker left alone (its Live view).
   */
  resumeHold(info: Pick<SessionInfo, 'id' | 'machineId'>): string | undefined {
    const p = this.plan(info.machineId);
    if (!p?.clearedAt) return undefined;
    if (!p.paused.includes(info.id) && p.told[info.id] === undefined) return undefined;
    return `${p.machine} is ${this.holdWhy(p).replace(/: no new work until it is done$/, '')}: this worker was paused for it and resumes when it is done (w1606)`;
  }

  // ---------------------------------------------------------------- the tool

  /** Mark a request as build work (WorkItem.build): it is placed on placement.build first from then on. */
  markBuild(w: WorkItem, sessionId: string, machineId: string) {
    this.d.markBuild?.(w, sessionId, machineId);
  }

  /** build_plan coming: a build on `machine` in `minutes`. Answers what happens, or why not. */
  declare(a: { machine: string; minutes: number; what: string; builder?: string; requests: string[]; by: string }): string {
    const machine = a.machine.trim().toLowerCase();
    const first = this.d.buildMachines();
    if (!first.includes(machine)) return `Builds run first on ${first.join(' > ')} (config placement.build, w1606); ${machine} is not one of them, so nothing is cleared for it. Build where you are, or ask the dispatcher to move this work to ${first[0]} (stop_agent move_to) when it has room.`;
    const minutes = Math.max(0, Math.min(MAX_LEAD_MIN, Math.round(Number(a.minutes) || 0)));
    const now = this.now();
    const old = this.plans.get(machine);
    if (old && !(a.builder && this.isBuilder(old, a.builder)) && !(a.by === 'the dispatcher' && old.by === 'the dispatcher')) {
      return `Not now: ${machine} is ${this.holdWhy(old).replace(/: no new work until it is done$/, '')}. One build at a time there: declare yours once that one is done (build_plan status), or build where you are.`;
    }
    const plan: BuildPlan = old
      ? { ...old, what: a.what || old.what, dueAt: old.clearedAt ? old.dueAt : now + minutes * 60_000, requests: [...new Set([...old.requests, ...a.requests])] }
      : { machine, what: (a.what || 'a player build').slice(0, 160), ...(a.builder ? { builder: a.builder } : {}), requests: a.requests, by: a.by, declaredAt: now, dueAt: now + minutes * 60_000, told: {}, paused: [], moved: [], kept: [] };
    this.plans.set(machine, plan);
    this.save();
    this.d.log(`build: ${plan.by} declared ${plan.what} on ${machine}, due ${hhmm(plan.dueAt)}${plan.requests.length ? ` (${plan.requests.join(', ')})` : ''}`);
    if (!old) this.d.notify(`[ledger] BUILD COMING (w1606): ${plan.by} builds ${plan.what} on ${machine} at ${hhmm(plan.dueAt)} (in ${minutes} min)${plan.requests.length ? ` for ${plan.requests.join(', ')}` : ''}. No new work goes to ${machine} until it is done (Capacity shows it held). At ${hhmm(plan.dueAt)} FF Factory moves the workers there that are between turns to computers with room and pauses the rest at a safe point; it resumes them when the build is done. Nothing for you to do unless you want to place its request: then on ${machine}.`);
    if (minutes === 0) void this.clear(plan);
    return `Declared (w1606): ${plan.what} on ${machine} at ${hhmm(plan.dueAt)}. No new work goes there from now. ${minutes === 0 ? 'FF Factory clears it now' : `At ${hhmm(plan.dueAt)} FF Factory clears it`}: the workers between turns move to other computers with room, the ones mid-turn finish their step and pause, and a Live view that runs is left alone. When you are ready, build_plan start: it says go, or what it still waits for. After the build, build_plan done.`;
  }

  /** build_plan start: go, or what the build still waits for. Starting before the due time clears the computer at once. */
  async start(builder: string | undefined, machineId: string): Promise<string> {
    let p = this.plan(machineId);
    if (!p) {
      const d = this.declare({ machine: machineId, minutes: 0, what: 'a player build', ...(builder ? { builder } : {}), requests: builder ? this.d.openRequestsOf(builder).map((w) => w.id) : [], by: builder ? `worker ${builder}` : 'the dispatcher' });
      p = this.plan(machineId);
      if (!p) return d;
    }
    if (builder && !this.isBuilder(p, builder)) return `Not yours: ${p.machine} is ${this.holdWhy(p).replace(/: no new work until it is done$/, '')}. Build where you are, or wait until it is done.`;
    if (!p.clearedAt) await this.clear(p);
    // w1628: a held bench lock no longer holds the build back here. The build's own Unity run takes a shared ticket in
    // the machine's bench queue (unity-slot run, the game repo's build_player.sh / ff_unity_slot, w1615), so it waits
    // for the timed leg running now and the ones queued before it, never runs beside one, and keeps its place ahead of
    // the legs queued after it. Waiting here for a free lock was a poll that lost: BEAST's lock was free for at most
    // 3.8 minutes at a time in the first 16 hours of 2026-10-20 (w1628's census).
    const lock = this.d.benchLock(p.machine);
    const queued = lock ? ` On ${p.machine}, ${benchText(lock)}: your build takes a shared ticket in its bench queue and starts as soon as that leg (and any queued before your build) ends, never beside one; \`python scripts/bench/bench_queue.py status\` shows its place (w1628).` : '';
    const busy = this.stillMidTurn(p);
    const waited = this.now() - (p.clearedAt ?? this.now());
    if (busy.length && waited < BUILD_WAIT_MS.value) {
      return `Not yet (w1606): ${busy.length} worker(s) on ${p.machine} were asked at ${hhmm(p.clearedAt!)} to finish their step and pause (${busy.join(', ')}); none is cut off mid-edit. wake_me in 5 minutes and build_plan start again; after ${mins(BUILD_WAIT_MS.value)} minutes of waiting the build goes ahead beside them.`;
    }
    if (!p.startedAt) {
      p.startedAt = this.now();
      this.save();
      this.d.log(`build: ${p.what} on ${p.machine} starts (${p.moved.length} moved, ${pausedOf(p).length} paused, ${p.kept.length} left alone${busy.length ? `; ${busy.join(', ')} still mid-turn after ${mins(waited)} min` : ''})`);
    }
    const kept = p.kept.length ? ` Left alone: ${p.kept.map((k) => `${k.session} (${k.why})`).join('; ')}.` : '';
    const late = busy.length ? ` ${busy.join(', ')} did not end its turn in ${mins(BUILD_WAIT_MS.value)} minutes; the build goes ahead beside it, a little slower.` : '';
    return `Go (w1606): ${p.machine} is cleared for ${p.what} (${p.moved.length} moved: ${p.moved.map((m) => `${m.session} to ${m.to}`).join(', ') || 'none'}; ${pausedOf(p).length} paused).${kept}${late} Build now through unity-slot run --label "${p.what}".${queued} When it is done (or failed), build_plan done at once: the paused work waits for it.`;
  }

  /** build_plan done: the hold lifts, the held resumes go, and every worker paused mid-turn is told to carry on. */
  done(machineId: string, why = 'its builder said it is done'): string {
    const p = this.plan(machineId);
    if (!p) return `No build is planned on ${machineId}.`;
    this.plans.delete(p.machine);
    this.save();
    const took = p.startedAt ? `${mins(this.now() - p.startedAt)} min` : 'never started';
    const resumed: string[] = [];
    for (const id of Object.keys(p.told)) {
      if (!this.d.isLive(id) && !this.d.workersOn(p.machine).some((s) => s.id === id)) continue;
      this.d.tell(id, `[FF Factory] The build on ${p.machine} is done (w1606): carry on where you stopped, in this conversation and sandbox. Start your editor again if you need it (mcp__machine__unity start).`);
      resumed.push(id);
    }
    this.d.kick?.();
    this.d.log(`build: ${p.what} on ${p.machine} done (${why}); build ${took}; ${p.moved.length} moved, ${resumed.length} resumed, ${idleOf(p).length} paused between turns resume with their own next message`);
    this.d.notify(`[ledger] BUILD DONE (w1606): ${p.what} on ${p.machine} (${why}; the build took ${took}). ${p.machine} takes new work again; ${resumed.length ? `${resumed.join(', ')} were told to carry on; ` : ''}${p.moved.length ? `moved earlier (place their Queued requests as usual): ${p.moved.map((m) => `${m.requests.join(', ')} to ${m.to}`).join('; ')}.` : 'nothing was moved.'}`);
    return `Done (w1606): ${p.machine} takes work again; the build took ${took}. ${resumed.length} paused worker(s) told to carry on; ${idleOf(p).length} paused between turns resume with their own next message.`;
  }

  status(machineId?: string): string {
    const list = machineId ? [this.plan(machineId)].filter((p): p is BuildPlan => !!p) : this.all();
    if (!list.length) return `No build is planned${machineId ? ` on ${machineId}` : ''}. Builds run first on ${this.d.buildMachines().join(' > ')} (placement.build, w1606).`;
    return list.map((p) => `${p.machine}: ${this.holdWhy(p).replace(/: no new work until it is done$/, '')}; moved ${p.moved.length}, paused between turns ${idleOf(p).length}, asked to pause ${Object.keys(p.told).length} (${this.stillMidTurn(p).length} still mid-turn), left alone ${p.kept.length}.`).join('\n');
  }

  // ---------------------------------------------------------------- the clock

  /** Every 30 s: a plan that came due is cleared; a told worker whose turn ended is paused; an old or orphaned plan ends. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const p of [...this.plans.values()]) {
      if (now - p.dueAt > PLAN_MAX_MS.value) {
        this.done(p.machine, `not ended ${mins(PLAN_MAX_MS.value)} min after it was due, so FF Factory ended it`);
        continue;
      }
      if (p.builder && !this.d.isLive(p.builder) && p.requests.length && p.requests.every((id) => !this.d.openRequestsOf(p.builder!).some((w) => w.id === id)) && !this.d.workersOn(p.machine).some((s) => s.id === p.builder)) {
        this.done(p.machine, 'its builder is gone and its requests are no longer its');
        continue;
      }
      if (!p.clearedAt && now >= p.dueAt) await this.clear(p);
      let changed = false;
      for (const id of Object.keys(p.told)) {
        const s = this.d.workersOn(p.machine).find((x) => x.id === id);
        if (s && this.d.isLive(id) && this.d.isMidTurn(s)) continue;
        if (!p.paused.includes(id)) {
          p.paused.push(id);
          changed = true;
        }
      }
      if (changed) this.save();
    }
  }

  private stillMidTurn(p: BuildPlan): string[] {
    return Object.keys(p.told).filter((id) => {
      const s = this.d.workersOn(p.machine).find((x) => x.id === id);
      return !!s && this.d.isLive(id) && this.d.isMidTurn(s);
    });
  }

  /** Clear the computer for the build: move first, pause as the fallback, never cut a turn off (the header). */
  async clear(p: BuildPlan): Promise<void> {
    if (p.clearedAt || this.clearing.has(p.machine)) return;
    this.clearing.add(p.machine);
    try {
      p.clearedAt = this.now();
      for (const s of this.d.workersOn(p.machine)) {
        if (this.isBuilder(p, s.id)) continue;
        const reqs = this.d.openRequestsOf(s.id);
        if (this.d.hasView(s.id)) {
          p.kept.push({ session: s.id, why: 'its Live view runs: a person may be steering it, and a move would end it' });
          continue;
        }
        const live = this.d.isLive(s.id);
        if (live && (this.d.isMidTurn(s) || s.pendingPermissions?.length)) {
          p.told[s.id] = this.now();
          this.d.tell(s.id, pauseNotice(p, reqs.map((w) => w.id)));
          continue;
        }
        const to = reqs.length ? this.d.moveTarget(s, p.machine) : undefined;
        if (to) {
          try {
            await this.d.move(s.id, to, `${p.machine} is cleared for a build (${p.what}; w1606: builds run there alone)`);
            p.moved.push({ session: s.id, to, requests: reqs.map((w) => w.id) });
            continue;
          } catch (e) {
            this.d.log(`build: could not move ${s.id} off ${p.machine} to ${to} (${(e as Error).message}): it is paused there instead`);
          }
        }
        p.paused.push(s.id);
      }
      this.save();
      this.d.log(`build: cleared ${p.machine} for ${p.what}: moved ${p.moved.map((m) => `${m.session} to ${m.to}`).join(', ') || 'none'}; paused between turns ${p.paused.join(', ') || 'none'}; asked to pause ${Object.keys(p.told).join(', ') || 'none'}; left alone ${p.kept.map((k) => k.session).join(', ') || 'none'}`);
      if (p.moved.length || Object.keys(p.told).length) {
        this.d.notify(`[ledger] BUILD CLEARING (w1606): ${p.machine} for ${p.what}. ${p.moved.length ? `Moved off it (their requests are Queued for the computer named, with their branch: place each there as the MOVED lines say): ${p.moved.map((m) => `${m.requests.join(', ')} to ${m.to}`).join('; ')}. ` : ''}${Object.keys(p.told).length ? `Asked to pause at a safe point: ${Object.keys(p.told).join(', ')}; FF Factory resumes them when the build is done. ` : ''}Start nothing on ${p.machine} meanwhile.`);
      }
    } finally {
      this.clearing.delete(p.machine);
    }
  }

  // ---------------------------------------------------------------- the file

  restore(): number {
    if (!this.d.file) return 0;
    let saved: Record<string, BuildPlan> = {};
    try {
      saved = readJsonDurable<Record<string, BuildPlan>>(this.d.file, { check: checkObject }) ?? {};
    } catch {
      return 0;
    }
    for (const [id, p] of Object.entries(saved)) if (p && typeof p.dueAt === 'number') this.plans.set(id, { ...p, told: p.told ?? {}, paused: p.paused ?? [], moved: p.moved ?? [], kept: p.kept ?? [], requests: p.requests ?? [] });
    return this.plans.size;
  }

  private save() {
    if (!this.d.file) return;
    try {
      writeJsonDurable(this.d.file, Object.fromEntries(this.plans), { indent: 2 });
    } catch (e) {
      console.warn('build plans: could not save:', (e as Error).message);
    }
  }
}

/** The build_plan tool's description, the worker's and the dispatcher's (w1606). */
export const BUILD_PLAN_DOC =
  'Builds run first on BEAST (w1606, placement.build): say a player build is coming, so FF Factory clears that computer for it. action coming (minutes: lead time, what) holds it for new work at once, and when due moves the workers there between turns to other computers and pauses the rest at a safe point (never mid-edit); start says go, or what it still waits for (a bench lock\'s timed run, workers finishing their step); done ends it and resumes the paused work; status. A worker declares its own build (it runs where the worker is); the dispatcher one for a request (work_id).';
