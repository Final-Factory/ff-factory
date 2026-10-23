// Builds first on BEAST (w1606, docs/orchestrators.md "Builds clear BEAST"). Ben, 2026-10-20: "i want to make it so, when you
// know builds are coming up, we also prioritize using beast for builds because its faster. so when it's coming time, move
// work off beast, or when apropriate, pause work and finish the build, then resume. make this a rule of FFF".
//
// SINCE w1639 THE ONLY RELEASE BUILD ON THESE COMPUTERS IS THE URGENT LANE'S (lothsahn, 2026-10-20: "Release builds should
// be handed by ffbox ... If we need an urgent build, we should be able to ask beast or Lothdesktop to build it for us. For
// that, we need to kick everyone else off the box (or at least have them pause) ... a quick or urgent release (beast, if
// offline, LothDesktop)"). A normal release is FFBox's and declares nothing here.
//
// A worker (or the dispatcher, for a request) declares a build coming on a build computer (placement.build, DEFAULT_BUILD:
// beast, then lothdesktop; an OFFLINE one is refused, naming the next online one) with a rough lead time, through the
// build_plan tool. A timed leg in that computer's bench queue no longer sends it elsewhere (w1628 did, for release builds
// in general): the release's own Unity runs take EXCLUSIVE tickets at its request's urgent priority, so they wait only for
// the leg running now. Then:
// - From the declaration, the computer is held for new work (Agents.placement() adds holds()): nothing new is placed there,
//   no released worker resumes there, nothing is moved there. Its workers go on as they are until the build is due.
// - When it is due, FF Factory clears it (clear()). Each other worker there:
//   - one whose Live view runs is left in place, editor and view open: a Live view a person may be steering beats a build,
//     and a move ends the view. It is asked (liveViewNotice) to start no compile, test run or player build until the build
//     is done, and told when it is (the build runs beside the view, a little slower);
//   - one between turns is moved (Agents.moveWorker, the w1600 route: process stopped, work saved and pushed, its requests
//     Queued for the other computer with their branch) to the computer the general placement picks, when one has room;
//     when none has, it is paused in place: its resumes (a check-in, CI, a reply) wait in the send queue (resumeHold) until
//     the build is done, and then go;
//   - one mid-turn is asked to finish its step, commit and push, stop its editor and end its turn (pauseNotice): never cut
//     off. Once its turn ends it is paused the same way, and when the build is done FF Factory resumes it (done()).
// - The build starts when its worker asks (build_plan start), AT ONCE (w1656, lothsahn: a release build does not wait for
//   other workers to pause; it starts at once and takes the bench lock first). Clearing still moves the workers between
//   turns and asks the ones mid-turn to finish their step and start no new Unity work; the build does not wait for them
//   (1.0.0.3 waited 20 minutes for one, then behind that worker's test run). Its builder's bench tickets count as urgent
//   whatever its request's priority (Agents.benchPriorities, releaseBuilder), and they PRE-EMPT the machine's bench queue
//   (the game repo's bench_queue.py: every holder's batch run or leg stops, to run again after done). At the start FF
//   Factory also stops the editor of every worker it paused or asked to pause (stopEditor), so an editor compile or test
//   run ends at once and its Unity slot is free; never a Live view's editor (left alone above) nor the builder's.
//   lothsahn (w1656), after 1.0.0.3 waited 12 minutes here and 15 more behind a worker's compile and test run: "Why did it
//   have to wait so long for the lock? i said it was urgent. How do we never let this happen again? It was supposed to kick
//   work off the machine".
// - build_plan done (or PLAN_MAX_MS past due, or its builder's requests all closed) ends it: the hold lifts, the queued
//   resumes go, and each worker paused mid-turn is told to carry on.
import type { BenchLock, BenchQueueReport, BuildHold, SessionInfo, WorkItem } from '../shared/types.ts';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';
import { benchText, timedText } from './placement.ts';
import { gaveUpNotice, RELEASE_SANDBOX, SEAT_GIVE_UP_MS, seatedNotice, type Seat } from './releaseSeat.ts';

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
  /** w1668: its builder being moved into the build computer's slot1 (server/releaseSeat.ts). */
  seat?: Seat;
}

/** What one step towards the builder working in slot1 did (Agents.seatRelease, w1668). */
export interface SeatResult {
  /** The builder is there now (moved: by this step), or there was nothing to move. */
  done?: string;
  moved?: boolean;
  /** Slot1 could not be emptied in time: the builder builds where it is. */
  gaveUp?: string;
  /** What it still waits for. */
  wait?: string;
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
  /** The timed legs in its bench queue, running or waiting (w1628, MachineStats.benchQueue). */
  benchQueue?: (machineId: string) => BenchQueueReport | undefined;
  /** Where an urgent release goes now (the release placement: the first online build computer with room). */
  releaseTarget?: () => string | undefined;
  /** Whether a computer's daemon is connected now (w1639: an urgent release skips an offline BEAST for LothDesktop). */
  machineOnline?: (machineId: string) => boolean;
  /** Another computer with room for this worker's work (the general placement, never `from`), or undefined. */
  moveTarget: (info: SessionInfo, from: string) => string | undefined;
  /** Agents.moveWorker: resolves with its answer, throws with why not. */
  move: (sessionId: string, to: string, why: string) => Promise<string>;
  /** A system message into a worker's turn (or the next one). */
  tell: (sessionId: string, text: string) => void;
  /** Stop the editor of this worker's sandbox (w1656: a release build starts; its compile or test run ends, to run again). */
  stopEditor?: (sessionId: string) => Promise<string | undefined>;
  /**
   * w1668: one step towards the builder working in the build computer's slot1 (Agents.seatRelease, server/releaseSeat.ts):
   * empty slot1 of other game work, then move the builder there. Unset: builds run where their builder is.
   */
  seat?: (p: BuildPlan, builderId: string) => Promise<SeatResult>;
  /**
   * w1856: at done, put the sandboxes the build's workers switched to a release branch back on the branch they left
   * (Agents.handBackRelease, server/releaseHandBack.ts), before the paused workers carry on there. One note per sandbox.
   */
  handBack?: (p: BuildPlan, caller?: string) => Promise<string[]>;
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
    '1. Finish the step you are on and start no new one: no compile, refresh, test run, player build or batch Unity run. The release starts now and takes the bench first (w1656): a batch run or leg of yours stops, and FF Factory stops your editor, so a compile or test run ends and is run again after the build. Commit what is unfinished on your branch (a WIP commit is fine) and push it.',
    "2. Stop your sandbox's Unity editor (mcp__machine__unity stop) and any player or batch run you started, unless a person is watching your Live view now.",
    `3. End your turn with one line per request: \`${example}: paused for the build on ${p.machine}; <where you stopped>\`. Set no wake_me for it.`,
    `Your check-ins and replies wait meanwhile, and when the build is done FF Factory tells you to carry on, in this same conversation and sandbox. If \`build_plan status\` says no build is planned on ${p.machine}, it is over: ignore this and carry on.`,
  ].join('\n');
}

/**
 * What a worker whose Live view runs on a computer being cleared for a build is told (w1639): its editor and view stay as
 * they are, for the person who may be using them; only the heavy work it would start waits.
 */
export function liveViewNotice(p: Pick<BuildPlan, 'machine' | 'what' | 'by'>): string {
  return [
    `[FF Factory] BUILD (w1606, w1639): ${p.by} builds ${p.what} on ${p.machine} now. Your Live view stays open and your editor runs: a person may be using them, and nothing of yours is moved or closed.`,
    'Until FF Factory says the build is done, start no compile, refresh, test run, player build or batch Unity run: the release has this computer\'s cores. Answering the person, looking, and edits that need no compile go on as usual.',
    `If \`build_plan status\` says no build is planned on ${p.machine}, it is over: carry on.`,
  ].join('\n');
}

export class BuildPlans {
  private readonly d: BuildDeps;
  private readonly now: () => number;
  private readonly plans = new Map<string, BuildPlan>();
  private clearing = new Set<string>();
  /** Computers whose seat step runs now (w1668). */
  private readonly seating = new Set<string>();

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

  /** Whether this worker builds the release planned on its computer now (w1656): its bench tickets then count as urgent. */
  releaseBuilder(machineId: string, sessionId: string): boolean {
    const p = this.plan(machineId);
    return !!p && this.isBuilder(p, sessionId);
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

  /**
   * The build that paused this worker (w1841): its requests show Blocked on it (shared/workState.ts). From the clearing until
   * done; told: asked to pause mid-turn, so done tells it to carry on.
   */
  pausedFor(sessionId: string): BuildHold | undefined {
    return this.pausedAmong([sessionId])[sessionId];
  }

  /** pausedFor for each of these workers a build paused, by session id (the page's live states, AppState.buildHolds). */
  pausedAmong(ids: Iterable<string>): Record<string, BuildHold> {
    const out: Record<string, BuildHold> = {};
    const plans = [...this.plans.values()].filter((p) => p.clearedAt).map((p) => ({ p, paused: new Set(p.paused) }));
    if (!plans.length) return out;
    for (const id of ids) {
      const x = plans.find((y) => y.p.told[id] !== undefined || y.paused.has(id));
      if (x) out[id] = { what: x.p.what, machine: x.p.machine, told: x.p.told[id] !== undefined };
    }
    return out;
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
    // w1639, lothsahn: "a quick or urgent release (beast, if offline, LothDesktop)": an offline build computer is refused,
    // naming the next online one. A timed leg in the bench queue no longer sends the build elsewhere (w1628 did): the
    // release's exclusive tickets at its urgent priority wait only for the leg running now.
    if (!old && this.d.machineOnline && !this.d.machineOnline(machine)) {
      const next = first.find((id) => id !== machine && this.d.machineOnline!(id));
      return `Not on ${machine} (w1639): it is offline. ${next ? `An urgent release builds on ${next} then: ${a.builder ? `ask the dispatcher to move this work there (stop_agent move_to ${next})` : `build_plan coming with machine ${next}, and place its request there`}.` : `No build computer (${first.join(', ')}) is online: say so to the requester; a normal release (FFBox) needs none.`}`;
    }
    const timed = old ? undefined : this.d.benchQueue?.(machine);
    if (old && !(a.builder && this.isBuilder(old, a.builder)) && !(a.by === 'the dispatcher' && old.by === 'the dispatcher')) {
      return `Not now: ${machine} is ${this.holdWhy(old).replace(/: no new work until it is done$/, '')}. One build at a time there: declare yours once that one is done (build_plan status), or build where you are.`;
    }
    const queuedNote = timed ? ` ${machine} ${timedText(timed)}: the release's exclusive tickets, at its request's urgent priority, go first after the leg running now, never beside one.` : '';
    const plan: BuildPlan = old
      ? { ...old, what: a.what || old.what, dueAt: old.clearedAt ? old.dueAt : now + minutes * 60_000, requests: [...new Set([...old.requests, ...a.requests])] }
      : { machine, what: (a.what || 'a player build').slice(0, 160), ...(a.builder ? { builder: a.builder } : {}), requests: a.requests, by: a.by, declaredAt: now, dueAt: now + minutes * 60_000, told: {}, paused: [], moved: [], kept: [] };
    this.plans.set(machine, plan);
    this.save();
    this.d.log(`build: ${plan.by} declared ${plan.what} on ${machine}, due ${hhmm(plan.dueAt)}${plan.requests.length ? ` (${plan.requests.join(', ')})` : ''}`);
    if (!old) this.d.notify(`[ledger] BUILD COMING (w1606): ${plan.by} builds ${plan.what} on ${machine} at ${hhmm(plan.dueAt)} (in ${minutes} min)${plan.requests.length ? ` for ${plan.requests.join(', ')}` : ''}. No new work goes to ${machine} until it is done (Capacity shows it held). At ${hhmm(plan.dueAt)} FF Factory moves the workers there that are between turns to computers with room and pauses the rest at a safe point; it resumes them when the build is done. Nothing for you to do unless you want to place its request: then on ${machine}.`);
    if (minutes === 0) void this.clear(plan);
    return `Declared (w1606): ${plan.what} on ${machine} at ${hhmm(plan.dueAt)}.${queuedNote} No new work goes there from now. ${minutes === 0 ? 'FF Factory clears it now' : `At ${hhmm(plan.dueAt)} FF Factory clears it`}: the workers between turns move to other computers with room, the ones mid-turn finish their step and pause, and a Live view that runs stays open (its worker starts no compile, test or build meanwhile). When you are ready, build_plan start: it says go, or what it still waits for. The build runs in ${machine}'s ${RELEASE_SANDBOX}, its Library kept warm for release builds (w1668): a builder in another sandbox there is moved into it at the clearing, once its turn ends (start says so). After the build, build_plan done.`;
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
    // w1668: the build runs in the computer's slot1, its Library warm from the last release: the builder moves there first.
    // A builder placed here after the clearing gets its seat now.
    const here = builder ? this.d.workersOn(p.machine).find((s) => s.id === builder) : undefined;
    if (here && this.d.seat && !p.seat && here.machineSandbox !== RELEASE_SANDBOX) {
      p.seat = { sandbox: RELEASE_SANDBOX, since: this.now(), told: {} };
      this.save();
    }
    if (builder && this.seatPending(p)) {
      await this.seatStep(p);
      if (this.seatPending(p)) {
        const s = p.seat!;
        return `Not yet (w1668): urgent release builds run in ${p.machine}/${s.sandbox}, whose Library is kept warm for them (lothsahn: "urgent builds always get scheduled in slot1 on whatever machine they run in so that it uses caches as warm as possible"; a Library that never built Mac and Linux cost 1.0.0.3 about an hour more). Commit and push what is unfinished on your branch, then END YOUR TURN NOW, with no check-in: FF Factory empties ${s.sandbox} (its workers go to other sandboxes here, on their branches), moves you there on your branch and resumes you with a message, usually within two minutes. Then build_plan start again and build. If ${s.sandbox} cannot be emptied within ${SEAT_GIVE_UP_MS / 60_000} minutes you are told to build where you are. Now: ${s.waiting ?? 'emptying it'}.`;
      }
    }
    // w1628: a held bench lock no longer holds the build back here. The build's own Unity run takes a shared ticket in
    // the machine's bench queue (unity-slot run, the game repo's build_player.sh / ff_unity_slot, w1615), so it waits
    // for the timed leg running now and the ones queued before it, never runs beside one, and keeps its place ahead of
    // the legs queued after it. Waiting here for a free lock was a poll that lost: BEAST's lock was free for at most
    // 3.8 minutes at a time in the first 16 hours of 2026-10-20 (w1628's census).
    const lock = this.d.benchLock(p.machine);
    const queued = lock ? ` On ${p.machine}, ${benchText(lock)}: your build takes a shared ticket in its bench queue and starts as soon as that leg (and any queued before your build) ends, never beside one; \`python scripts/bench/bench_queue.py status\` shows its place (w1628).` : '';
    // w1656: no wait for the workers asked to pause. They finish their step beside the build and start no new Unity work
    // (pauseNotice); the build's exclusive tickets at urgent priority go first in the bench queue after the leg running now.
    const busy = this.stillMidTurn(p);
    let stopped: string[] = [];
    if (!p.startedAt) {
      p.startedAt = this.now();
      this.save();
      stopped = await this.stopEditors(p);
      this.d.log(`build: ${p.what} on ${p.machine} starts (${p.moved.length} moved, ${pausedOf(p).length} paused, ${p.kept.length} left alone${busy.length ? `; ${busy.join(', ')} still finishing their step` : ''})`);
    }
    const kept = p.kept.length ? ` Left alone: ${p.kept.map((k) => `${k.session} (${k.why})`).join('; ')}.` : '';
    const late = busy.length ? ` ${busy.join(', ')} still finishing their step (asked at ${hhmm(p.clearedAt!)} to start no new one): the release does not wait for them (w1656); your bench tickets count as urgent and pre-empt whatever holds the bench.` : '';
    const ended = stopped.length ? ` Stopped the editors of ${stopped.join(', ')} (w1656: their compiles and test runs run again after done).` : '';
    return `Go (w1606): ${p.machine} is cleared for ${p.what} (${p.moved.length} moved: ${p.moved.map((m) => `${m.session} to ${m.to}`).join(', ') || 'none'}; ${pausedOf(p).length} paused).${kept}${late}${ended} Build now through unity-slot run --label "${p.what}".${queued} When it is done (or failed), build_plan done at once: the paused work waits for it.`;
  }

  /**
   * build_plan done: the hold lifts, the release's sandbox goes back on its own branch (w1856), the held resumes go, and
   * every worker paused mid-turn is told to carry on. `caller`: the worker that said it.
   */
  async done(machineId: string, why = 'its builder said it is done', caller?: string): Promise<string> {
    const p = this.plan(machineId);
    if (!p) return `No build is planned on ${machineId}.`;
    this.plans.delete(p.machine);
    this.save();
    // w1856: before anyone paused in that sandbox carries on, so nobody commits on the release branch.
    let handed: string[] = [];
    if (this.d.handBack) {
      try {
        handed = await this.d.handBack(p, caller);
      } catch (e) {
        handed = [`the hand-back failed (${(e as Error).message}): no sandbox was switched back`];
      }
    }
    const back = handed.length ? ` Hand-back (w1856): ${handed.join('; ')}.` : '';
    const took = p.startedAt ? `${mins(this.now() - p.startedAt)} min` : 'never started';
    const resumed: string[] = [];
    for (const id of Object.keys(p.told)) {
      // w1841: also one placed again on another computer since (its sandbox went to other work while it waited): it still
      // holds the work it paused, and nothing else brings it back.
      if (!this.d.isLive(id) && !this.d.workersOn(p.machine).some((s) => s.id === id) && !this.d.openRequestsOf(id).length) continue;
      this.d.tell(id, `[FF Factory] The build on ${p.machine} is done (w1606): carry on where you stopped, in this conversation and sandbox. Start your editor again if you need it (mcp__machine__unity start).`);
      resumed.push(id);
    }
    // The Live views left open (w1639): their heavy work may start again.
    for (const k of p.kept) {
      if (!this.d.isLive(k.session) && !this.d.workersOn(p.machine).some((s) => s.id === k.session)) continue;
      // w1838: its editor may have stopped meanwhile (it could not start beside the build), and its view holds until it is staged.
      this.d.tell(k.session, `[FF Factory] The build on ${p.machine} is done (w1639): compiles, tests and builds may start again. If your Live view is not streaming (live_view status), start your editor (mcp__machine__unity start) and stage it again now: a person may be waiting to use it.`);
    }
    this.d.kick?.();
    this.d.log(`build: ${p.what} on ${p.machine} done (${why}); build ${took}; ${p.moved.length} moved, ${resumed.length} resumed, ${idleOf(p).length} paused between turns resume with their own next message${back}`);
    this.d.notify(`[ledger] BUILD DONE (w1606): ${p.what} on ${p.machine} (${why}; the build took ${took}). ${p.machine} takes new work again; ${resumed.length ? `${resumed.join(', ')} were told to carry on; ` : ''}${p.moved.length ? `moved earlier (place their Queued requests as usual): ${p.moved.map((m) => `${m.requests.join(', ')} to ${m.to}`).join('; ')}.` : 'nothing was moved.'}${back}`);
    return `Done (w1606): ${p.machine} takes work again; the build took ${took}. ${resumed.length} paused worker(s) told to carry on; ${idleOf(p).length} paused between turns resume with their own next message.${back}`;
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
        await this.done(p.machine, `not ended ${mins(PLAN_MAX_MS.value)} min after it was due, so FF Factory ended it`);
        continue;
      }
      if (p.builder && !this.d.isLive(p.builder) && p.requests.length && p.requests.every((id) => !this.d.openRequestsOf(p.builder!).some((w) => w.id === id)) && !this.d.workersOn(p.machine).some((s) => s.id === p.builder)) {
        await this.done(p.machine, 'its builder is gone and its requests are no longer its');
        continue;
      }
      if (!p.clearedAt && now >= p.dueAt) await this.clear(p);
      if (this.seatPending(p)) await this.seatStep(p);
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

  /** The builder working on the build computer now, or undefined (the dispatcher declared it and none is placed there yet). */
  private builderOn(p: BuildPlan): SessionInfo | undefined {
    const on = this.d.workersOn(p.machine).filter((s) => this.isBuilder(p, s.id));
    return on.find((s) => s.id === p.builder) ?? on.find((s) => this.d.isLive(s.id)) ?? on[0];
  }

  /** Whether its builder is still being moved into slot1 (w1668). */
  private seatPending(p: BuildPlan): boolean {
    return !!p.seat && !p.seat.done && !p.seat.gaveUp && !!this.d.seat;
  }

  /** The sandbox a build's builder is being moved into, per computer, for PlaceAgain's claims (w1668): nobody else is placed there. */
  seats(machineId: string): Map<string, string> {
    const out = new Map<string, string>();
    const p = this.plan(machineId);
    const b = p && this.seatPending(p) ? this.builderOn(p) : undefined;
    if (p?.seat && b) out.set(p.seat.sandbox, b.id);
    return out;
  }

  /** One step towards the builder working in slot1 (w1668, Agents.seatRelease); the builder is told when it is there, or not. */
  private async seatStep(p: BuildPlan): Promise<void> {
    const s = p.seat!;
    const b = this.builderOn(p);
    if (!b || this.seating.has(p.machine)) return;
    this.seating.add(p.machine);
    let r: SeatResult;
    try {
      r = await this.d.seat!(p, b.id);
    } catch (e) {
      r = { wait: `failed: ${(e as Error).message}` };
    } finally {
      this.seating.delete(p.machine);
    }
    if (r.done) {
      s.done = r.done;
      delete s.waiting;
      this.d.log(`build: ${p.what} on ${p.machine}: ${r.done} (w1668)`);
      if (r.moved) this.d.tell(b.id, seatedNotice(p.machine, s.sandbox, p.what));
    } else if (r.gaveUp) {
      s.gaveUp = r.gaveUp;
      this.d.log(`build: ${p.what} on ${p.machine}: builds where its builder is: ${r.gaveUp} (w1668)`);
      this.d.tell(b.id, gaveUpNotice(p.machine, s.sandbox, r.gaveUp));
    } else s.waiting = r.wait;
    this.save();
  }

  /** w1656: the editors of the workers this build paused or asked to pause, stopped at its start (never a Live view's). */
  private async stopEditors(p: BuildPlan): Promise<string[]> {
    if (!this.d.stopEditor) return [];
    const kept = new Set(p.kept.map((k) => k.session));
    const out: string[] = [];
    for (const id of pausedOf(p)) {
      if (kept.has(id) || this.isBuilder(p, id) || this.d.hasView(id)) continue;
      if (!this.d.workersOn(p.machine).some((s) => s.id === id)) continue;
      try {
        const said = await this.d.stopEditor(id);
        if (said !== undefined) out.push(id);
      } catch (e) {
        this.d.log(`build: could not stop ${id}'s editor on ${p.machine}: ${(e as Error).message}`);
      }
    }
    if (out.length) {
      this.d.log(`build: ${p.what} on ${p.machine}: stopped the editors of ${out.join(', ')} (w1656)`);
      for (const id of out) this.d.tell(id, `[FF Factory] The release build on ${p.machine} started (w1656): FF Factory stopped your sandbox's Unity editor, so a compile or test run you had going ended. Nothing committed or saved is lost. When FF Factory says the build is done, start your editor again (mcp__machine__unity start) and run that step again.`);
    }
    return out;
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
          // w1639: its editor and view stay; only the heavy work it would start waits.
          this.d.tell(s.id, liveViewNotice(p));
          continue;
        }
        const live = this.d.isLive(s.id);
        // w1841: a worker that ended long ago and holds no open request is nobody to pause (the 1.0.0.10 build listed 7819).
        if (!live && !reqs.length) continue;
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
      // w1668: a builder on this computer outside slot1 is moved there (seatStep); slot1's other work goes first.
      const b = this.builderOn(p);
      if (b && this.d.seat && b.machineSandbox !== RELEASE_SANDBOX && !p.seat) p.seat = { sandbox: RELEASE_SANDBOX, since: this.now(), told: {} };
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

/**
 * build_plan's answer to a build that is not a release build (w1628). lothsahn, 2026-10-20: "Ben's guidance was only
 * supposed to be for release builds of the software, not all builds that workers do when making fixes".
 */
export const NOT_RELEASE = 'Nothing to plan (w1628): build_plan is for release builds only (release: true). lothsahn, 2026-10-20: "Ben\'s guidance was only supposed to be for release builds of the software, not all builds that workers do when making fixes". Your own player build (a fix, a clip, a playtest or MP check) clears nothing and moves nobody: build where you are, through `unity-slot run` (or the game repo\'s build_player.sh). Its shared ticket in the machine\'s bench queue keeps it from running beside a timed leg, and it joins the builds waiting there.';

/** The build_plan tool's description, the worker's and the dispatcher's (w1606). */
export const BUILD_PLAN_DOC =
  'The urgent release lane\'s build only (w1639; release builds only since w1628; lothsahn, 2026-10-20: "Ben\'s guidance was only supposed to be for release builds of the software, not all builds that workers do when making fixes"): a normal release is FFBox\'s and plans nothing here, and a worker\'s own player build (a fix, a clip, a playtest or MP check) needs no plan and clears nothing: build where you are through unity-slot run. A quick or urgent release builds on BEAST, else LothDesktop when BEAST is offline (w1639, placement.build), whatever timed legs wait in the bench queue (its exclusive tickets at its urgent priority go first after the leg running now): say it is coming (release: true), so FF Factory clears that computer for it; a Live view there stays open, and its worker is asked to start no compile, test or build meanwhile. action coming (release: true, minutes: lead time, what) holds it for new work at once, and when due moves the workers there between turns to other computers and pauses the rest at a safe point (never mid-edit); start (release: true) says go, or what it still waits for (workers finishing their step); done ends it, puts the release\'s sandbox back on the branch it left for urgent/<v> (w1856) and resumes the paused work; status. A worker declares its own release build (it runs where the worker is); the dispatcher one for a request (work_id).';
