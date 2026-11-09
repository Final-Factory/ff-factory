// The blocker watch (w643; docs/orchestrators.md, "Waiting, Queued, Blocked"). Every minute, and at once when a request
// is blocked, it looks at each Blocked request's blocker (shared/blockers.ts blockerVerdict) and:
//
// - clear: unblocks it, and the dispatcher is told to start it now (Orchestrators.unblock), with no person nudging it. A request
//   with several gates (w754) is unblocked only when all have cleared; the cleared ones are dropped as they clear;
// - stuck (the blocker stalled, or did not clear in its time): stalls it with the reason (Orchestrators.blockerStuck);
// - decide (what it waited on closed without delivering): asks its requester (Orchestrators.blockerDecide);
// - open: leaves it, and the ledger cleanup leaves it too (stallCandidate never takes a blocked request).
//
// CI (w829): checks are read from statusCheckRollup, and where GitHub refuses that (a fine-grained token has no Checks
// permission) from the pull request's GitHub Actions runs. A read that fails is logged, and checks unreadable for
// CI_UNREADABLE_MS clear the block so its worker looks itself; the check-in a block cancelled is handed back on any clear
// (Orchestrators.unblock).
//
// A block that is only a wait for capacity (a free sandbox, slot, editor, RAM) is Queued instead (requeueCapacityBlocks, w1089).
// It also flags requests queued for capacity while a computer that could take them has room (flagQueuedWithRoom).
// A deploy blocker the ledger cleanup set itself (a merged request whose only step left is a deploy) is the cleanup's:
// it closes the request when the deploy runs the merge (server/ledgerSweep.ts), so this watch leaves it alone.
import type { Store } from './store.ts';
import type { Orchestrators } from './orchestrators.ts';
import { run as runProc, type RunOptions, type RunResult } from './proc.ts';
import { blockerVerdict, CI_REF, cycleBreak, FULL_SHA, gateSetter, gatesOf, newestFirst, ownsPr, prLabel, RESUME_SWEEP_MS, sameCommit, waitCycles, type BlockerFacts, type PrHealth } from '../shared/blockers.ts';
import { conditionalVerdict } from '../shared/conditional.ts';
import { ghRunner, isRateLimitText } from './githubTokens.ts';
import { budgetOf, ghGet, GH_LOW_EVERY_MS, GH_LOW_REMAINING } from './ghBudget.ts';
import { evidenceArgs, evidenceGated, evidencePython, evidenceRefusal, evidenceVerdict, fetchHudData, findLocalPrEvidence, noScriptRefusal } from '../machine/evidenceGate.ts';
import { pairDelivers, reportDelivers, requestIdsIn, stillOpenIn } from './ledgerRules.ts';
import { isOpen } from './work.ts';
import { diskWaitIn, lastOpenLine, personWaitOn, portalWaitIn, reportAt, requestWaitOf, siblingWaitOf } from '../shared/workState.ts';
import type { SessionInfo, WorkBlocker, WorkItem } from '../shared/types.ts';
import type { RoomNow } from './placement.ts';
import { steamShortIn } from '../shared/capacity.ts';
import { awayLabelsOf, awayNote, failedNote, isAwayLeg, settleJobs, offlineByMachine, offlineLabels, type Leg } from '../machine/awayRunners.ts';

const EVERY_MS = 60_000;
/**
 * A pull request's checks are read at most this often each (gh; GitHub's rate limit is 5000 calls an hour, and a read is
 * 1 call, 3 where the checks are refused: 10 gates cost at most 900 an hour). Two minutes (w846, was 5): a worker waiting
 * on CI is resumed within about 4 minutes of its checks finishing (2 to read, 1 for the watch, 1 for its check-in).
 */
const CI_EVERY_MS = 2 * 60_000;
/** w3786: a CI reading is kept per pull request and commit waited on ("owner/repo#1@<sha>"; the bare ref with no head). */
const ciKey = (ref: string, head?: string) => (head ? `${ref}@${head.toLowerCase()}` : ref);
/** A pull request that cannot be read is logged when it starts failing and again this often while it does (w829). */
const READ_FAIL_LOG_MS = 30 * 60_000;
const BUSY: ReadonlySet<SessionInfo['status']> = new Set(['running', 'starting', 'waiting_permission']);

/** `none`: no check or workflow run exists for the pull request's head yet (w907: it may never get one). */
/** `green` (w2045): done with every check passed or skipped, the only reading the merge-on-green pilot merges on. */
/** `failed` (w2140): the failed runs, "Windows tests: failure", when it finished red. */
/** `head` (w3786): the commit the reading is of, when known. */
export type CiState = { done: boolean; text: string; none?: boolean; green?: true; failed?: string; head?: string };
/** A pull request's state (w754): open, merged, or closed without merging, and a line saying how. */
export type PrState = { state: 'open' | 'merged' | 'closed'; text: string; sha?: string };

export interface BlockerWatchDeps {
  store: Store;
  orchestrators: Pick<Orchestrators, 'unblock' | 'blockerStuck' | 'blockerDecide' | 'gatesCleared' | 'flagQueuedWithRoom' | 'carryOutConditional' | 'dropConditional'> &
    Partial<Pick<Orchestrators, 'tellPrConflict' | 'recordReportedWait' | 'retellReportWaits' | 'noticeLongOffline' | 'noteCiRead' | 'noteReadPaused' | 'sweepResumes' | 'requeueCapacityBlocks' | 'requeueBrokenPairs' | 'replaceNoTimedWaits' | 'timedLegBound' | 'mergedOnGreen' | 'undecidedBound' | 'holdSteamPairs' | 'flagDeadWait'>>;
  /** w1841: tell the workers waiting on a bench lock that is free now (Agents.resumeBenchWaits): request id to what it did. */
  benchResume?: () => [string, string][];
  /** w2544: work waiting on a computer away (offline or paused) past the grace moves elsewhere (Agents.moveAwayWork). */
  awayMove?: () => [string, string][];
  /** Whether a message to a session waits in the send queue (for a sandbox, a slot or its machine): its resume is on its way (w1094). */
  queued?: (sessionId: string) => boolean;
  /** Whether a session's wake_me check-in is pending (w2422: a worker that will come back by itself is left be). */
  checkInPending?: (sessionId: string) => boolean;
  /** The commit the portal runs. */
  portalSha?: () => string | undefined;
  /** The commit a machine's daemon runs. */
  daemonSha?: (machineId: string) => string | undefined;
  /** Whether a machine is online; undefined for one this portal does not have. */
  online?: (machineId: string) => boolean | undefined;
  /** w2443: whether a machine is paused from its tray app. */
  paused?: (machineId: string) => boolean;
  /** Whether a Claude account's meters are clear (by its email or label); undefined when unknown. */
  usageClear?: (account: string) => boolean | undefined;
  /** w3338: a machine's sandbox volume, its free bytes and its warning line (Machines.diskRoom); undefined when unknown. */
  disk?: (machineId: string) => { freeBytes: number; warnGB: number } | undefined;
  /** When the nightly lab last posted its results (ms). */
  nightlyAt?: () => number | undefined;
  /**
   * A pull request's checks ("owner/repo#123"); default gh, on the GitHub token of `person` (the person the first request
   * waiting on it is for, w868; server/githubTokens.ts). Throws (or answers undefined) when they cannot be read.
   */
  ci?: (ref: string, person?: string, head?: string) => Promise<CiState | undefined>;
  /** A pull request's head and mergeability ("owner/repo#123", w907); default gh, as for ci. */
  prHealth?: (ref: string, person?: string) => Promise<PrHealth | undefined>;
  /** A pull request's state ("owner/repo#123"); default gh, as for ci. */
  pr?: (ref: string, person?: string) => Promise<PrState | undefined>;
  /** w2045: merge a pull request at exactly this head (merge-on-green pilot); default gh, as for ci. Throws with what GitHub said. */
  merge?: (ref: string, head: string, person?: string) => Promise<void>;
  /**
   * w3110: where the default merge finds pr_evidence.py. The portal passes its own checkout (machine/evidenceGate.ts
   * portalPrEvidence): this runs on the portal, which has no plugin cache or FF_SKILLS. Default: findLocalPrEvidence.
   */
  evidenceScript?: () => string | undefined | Promise<string | undefined>;
  /** Whose GitHub token a request's reads use (w868); undefined: the portal's own gh login. */
  githubPerson?: (w: WorkItem) => string | undefined;
  /** The computers with room for one more game worker now. */
  room?: () => string[];
  /** Room for each kind of work and the held computers (w1089, w1098); preferred over `room`. */
  roomFacts?: () => RoomNow;
  now?: () => number;
}

/** w2422: how old a worker's report may be for the ledger to record the wait it names (older ones are a person's to look at). */
export const REPORTED_WAIT_MS = 3 * 24 * 3600_000;
/** A worker that is not in a turn. */
const STOPPED: ReadonlySet<string> = new Set(['idle', 'stopped', 'error']);
/** w2457: how long a waited-on request's worker sits idle with nothing to wake it before the wait is flagged. */
const DEAD_WAIT_MS = 30 * 60_000;

export class BlockerWatch {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private again = false;
  private readonly ciSeen = new Map<string, { at: number; state?: CiState }>();
  /** w1094: since when this portal has read each pull request's checks as finished. */
  private readonly ciDoneAt = new Map<string, number>();
  /** w1094: requests the sweep has said are still Blocked on finished CI ("<id>@<ref>"), so it says each once. */
  private readonly swept = new Set<string>();
  private readonly deadFlagged = new Set<string>();
  /** w829: pull requests whose checks could not be read: since when, why, and when that was last logged. */
  private readonly ciFailing = new Map<string, Failing>();
  private readonly healthSeen = new Map<string, { at: number; state?: PrHealth }>();
  /** "<ref>@<head sha>" to when this portal first saw that head (w907: the clock of the no-CI-run rule). */
  private readonly headFirstSeen = new Map<string, number>();
  /** w3572: the conflicting pull request heads (`ref@head`) whose owner was told, or found to have none: once each. */
  private readonly conflictTold = new Set<string>();
  private readonly prSeen = new Map<string, { at: number; state?: PrState }>();
  private readonly healthFailing = new Map<string, Failing>();
  private readonly prFailing = new Map<string, Failing>();
  /** w3758: pull requests whose reads GitHub's rate limit refuses now (their gates' logs say so once). */
  private readonly paused = new Set<string>();
  /** w3758: refusals that do not change, remembered between reads (ghChecks CheckReads). */
  private readonly refused = new Map<string, number>();
  private readonly d: BlockerWatchDeps;

  constructor(d: BlockerWatchDeps) {
    this.d = d;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  start() {
    // The first look waits for the server's module to finish loading (w1094: run at once, it read the usage meters before
    // they existed, "Cannot access 'usage' before initialization", and every restart lost its first look).
    this.kick();
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
    this.timer.unref?.();
    return this;
  }

  close() {
    clearInterval(this.timer);
  }

  /**
   * w2422: an open request with no gate whose newest worker stopped on a report that says it is blocked on another request
   * ("w2335: still open: blocked on w2338 reporting (the ledger may not show the block because the portal was
   * unreachable)") gets that wait as a gate, as if its blocked_on had been recorded. Before, the line showed Blocked only
   * while w2338 was open, nothing resumed the worker when it closed, and w2335 sat Stalled for 9 hours. Once per report; a
   * worker mid-turn, with a check-in pending or a message on its way, a wait on a request that waits on this one (a cycle,
   * w2357) and a report older than REPORTED_WAIT_MS are left be.
   */
  recordReportedWaits(): [string, string][] {
    const record = this.d.orchestrators.recordReportedWait?.bind(this.d.orchestrators);
    if (!record) return [];
    const now = this.now();
    const out: [string, string][] = [];
    for (const w of [...this.d.store.work.values()]) {
      try {
        if ((w.status !== 'active' && w.status !== 'stalled') || gatesOf(w).length) continue;
        // The newest worker's report (w2422); w2476: any other worker still on it, for a wait on another of its workers only (w2448's
        // b9cd085e waited on 17cae99a, the newer one, which ran on).
        const team = [...new Set([w.requestedBy, ...w.requesters].map((r) => r.displayName))];
        const newest = newestFirst(w).find((x) => this.d.store.sessions.get(x));
        for (const sid of newestFirst(w)) {
          const s = this.d.store.sessions.get(sid);
          if (!s || (sid !== newest && (w.done?.[sid] || w.movedOff?.[sid]))) continue;
          if (!STOPPED.has(s.status) || s.queuedSend || this.d.queued?.(s.id) || this.d.checkInPending?.(s.id)) continue;
          const l = lastOpenLine(w, s, now);
          // w2495: a line that waits on a person is the person's wait (the live state's Waiting on input), never a gate the
          // ledger infers, whatever else it names: w2443's "waiting on lothsahn to click Pause in FF Factory's tray" became
          // a deploy gate and held lothsahn's answer.
          if (l && personWaitOn(l.line, team)) continue;
          const ref = l ? requestWaitOf(l.line, w.id) : undefined;
          const portal = !!l && portalWaitIn(l.line, team);
          // w3338: a worker that stopped for low disk on its machine ("paused for low disk"), never a disk clean-up's own worker (w3328).
          const disk = !!l && !w.diskCleanup && !!s.machineId && diskWaitIn(l.line, team) ? s.machineId : undefined;
          // w2476: another worker of this request, still on it ("waiting for worker 17cae99a's LothLaptop leg").
          const siblings = w.sessionIds
            .filter((x) => x !== s.id && !w.done?.[x] && !w.movedOff?.[x])
            .map((x) => this.d.store.sessions.get(x))
            .filter((x): x is SessionInfo => !!x)
            .map((x) => ({ id: x.id, names: [x.machineId ?? '', x.sandboxId ?? ''] }));
          const sibling = l ? siblingWaitOf(l.line, siblings) : undefined;
          if (!l || (!sibling && (sid !== newest || (!ref && !portal && !disk)))) continue;
          const at = l.at ?? reportAt(s);
          const key = `${s.id}@${at}`;
          // w2457: a report from before its last gate went names a wait that is over (the deploy that woke it, the request it named).
          if (w.waitRecorded === key || !at || now - at > REPORTED_WAIT_MS || (w.gateEndedAt && at <= w.gateEndedAt)) continue;
          if (sibling) {
            if (record(w.id, s.id, { worker: sibling, line: l.line, at, key })) {
              out.push([w.id, `recorded: the wait on worker ${sibling} its worker ${s.id}'s report names (w2476)`]);
              break;
            }
            continue;
          }
          if (ref) {
            // One the request it names waits on in turn is a wait cycle: the cycle break (w2357, below) resumes a side of it.
            const other = this.d.store.work.get(ref);
            if (other && gatesOf(other).some((g) => g.kind === 'request' && g.ref?.toLowerCase() === w.id.toLowerCase())) continue;
            const onReport = new RegExp(`\\b${ref}\\b[^;.]{0,40}\\breport`, 'i').test(l.line);
            if (record(w.id, s.id, { ref, onReport, line: l.line, at, key })) {
              out.push([w.id, `recorded: the wait on ${ref} its worker ${s.id}'s report names (w2422)`]);
              break;
            }
          }
          // w3338: no open request named, but it stopped for low disk on its machine: that disk's recovery resumes it.
          if (disk && !ref && record(w.id, s.id, { disk, line: l.line, at, key })) {
            out.push([w.id, `recorded: the wait on disk space on ${disk} its worker ${s.id}'s report names (w3338)`]);
            break;
          }
          // w2457: no open request named (w2434's line quoted w1995, closed), but it waits on FF Factory: the next portal deploy.
          if (portal && record(w.id, s.id, { deploy: 'portal', line: l.line, at, key })) {
            out.push([w.id, `recorded: the wait on a portal deploy its worker ${s.id}'s report names (w2457)`]);
            break;
          }
        }
      } catch (e) {
        console.warn(`blocker watch: ${w.id}: recording its worker's reported wait: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /**
   * w2457: a request Blocked on another request (its finishing or its report) whose worker is stopped with nothing to wake
   * it for DEAD_WAIT_MS: no gate of its own, no check-in, no message on its way, no person asked. w2446 waited on w2434's
   * report while w2434's worker sat idle waiting on w2446's fix, which no gate named. Flagged once per stop of that worker
   * (Orchestrators.flagDeadWait), never cleared here: a person or the dispatcher decides which side moves.
   */
  flagDeadWaits(): [string, string][] {
    const flag = this.d.orchestrators.flagDeadWait?.bind(this.d.orchestrators);
    if (!flag) return [];
    const now = this.now();
    const out: [string, string][] = [];
    for (const w of [...this.d.store.work.values()]) {
      if (w.status !== 'blocked') continue;
      for (const g of gatesOf(w)) {
        const t = g.kind === 'request' && g.ref ? this.d.store.work.get(g.ref.toLowerCase()) : undefined;
        if (!t || (t.status !== 'active' && t.status !== 'stalled') || gatesOf(t).length) continue;
        const sid = newestFirst(t).find((x) => this.d.store.sessions.get(x));
        const s = sid ? this.d.store.sessions.get(sid) : undefined;
        if (!s || !STOPPED.has(s.status) || s.queuedSend || s.waitingOn || this.d.queued?.(s.id) || this.d.checkInPending?.(s.id)) continue;
        const since = Date.parse(s.lastActivityAt) || 0;
        const key = `${w.id}>${t.id}@${since}`;
        if (!since || now - since < DEAD_WAIT_MS || this.deadFlagged.has(key)) continue;
        this.deadFlagged.add(key);
        const why = `${t.id}, which it waits on, has nothing to wake it: its worker ${s.id} stopped ${Math.round((now - since) / 60_000)} min ago with no wait of its own, no check-in and no message on its way. Resume ${t.id}'s worker, or unblock ${w.id}`;
        flag(w.id, why);
        out.push([w.id, `flagged: ${why}`]);
      }
    }
    return out;
  }

  /** Look now (a request was just blocked, or something it may wait on changed). */
  kick() {
    setImmediate(() => void this.tick());
  }

  /** One look at every blocked request; returns what it did, by request id (for the tests). */
  async tick(): Promise<Map<string, string>> {
    const did = new Map<string, string>();
    if (this.busy) {
      this.again = true;
      return did;
    }
    this.busy = true;
    try {
      // w1089: a block that is only a wait for capacity is Queued, not Blocked, whoever set it and whenever.
      for (const id of this.d.orchestrators.requeueCapacityBlocks?.() ?? []) did.set(id, 'requeued: a block that waited only for capacity');
      // w2304: a pair run that lost a leg mid-run starts again whole, Queued, never Stalled.
      for (const id of this.d.orchestrators.requeueBrokenPairs?.() ?? []) did.set(id, 'requeued: a pair run that lost a leg mid-run');
      // w2422: a wait a stopped worker's report names with no blocked_on recorded becomes its gate first, so the look below
      // clears it and resumes that worker like any other.
      for (const [id, why] of this.recordReportedWaits()) did.set(id, why);
      // w3289: a worker on a request others wait on the report of, never told what to mark (it started, or slept, when the
      // block was set), is told now, so a milestone it reached (a release live with its notes posted) unblocks them.
      for (const [id, why] of this.d.orchestrators.retellReportWaits?.() ?? []) did.set(id, why);
      // w2433: requests Blocked on a machine offline past ledger.offlineNoticeMinutes under their workers are named to the dispatcher.
      for (const id of this.d.orchestrators.noticeLongOffline?.() ?? []) did.set(id, 'named to the dispatcher: its machine has been offline long');
      const blocked = [...this.d.store.work.values()].filter((w) => w.status === 'blocked' && w.blocked && w.blocked.by !== 'ledger cleanup');
      const ci = new Map<string, CiState | undefined>();
      const pr = new Map<string, PrState | undefined>();
      const health = new Map<string, PrHealth | undefined>();
      for (const w of blocked) {
        for (const g of gatesOf(w)) {
          if (!g.ref) continue;
          // A pull request several requests wait on is read once, on the first one's person's token.
          // w907: its head and mergeability, for a ci gate and for a pr gate its worker set itself. Read first (w3758): the
          // CI read takes its state and head from it instead of asking GitHub again.
          if ((g.kind === 'ci' || (g.kind === 'pr' && g.by.startsWith('worker '))) && !health.has(g.ref)) health.set(g.ref, await this.healthOf(g.ref, this.d.githubPerson?.(w)));
          // w3786: read per commit waited on, so a wait at a new head never takes the old head's reading.
          if (g.kind === 'ci' && !ci.has(ciKey(g.ref, g.head))) ci.set(ciKey(g.ref, g.head), await this.ciOf(g.ref, this.d.githubPerson?.(w), health.get(g.ref), g.head));
          else if (g.kind === 'pr' && !pr.has(g.ref)) pr.set(g.ref, await this.prOf(g.ref, this.d.githubPerson?.(w)));
        }
      }
      // w1094: what each pull request's checks say now, on its gates, so a gate still open says why in the ledger.
      for (const [key, state] of ci) if (state) this.d.orchestrators.noteCiRead?.(key.split('@')[0], state.text);
      // w3758: a read GitHub's rate limit refused pauses the gate (it never clears it), once in each waiting request's log.
      for (const ref of new Set([...ci.keys(), ...pr.keys()])) {
        const f = this.ciFailing.get(ref)?.rateLimited ? this.ciFailing.get(ref) : this.prFailing.get(ref)?.rateLimited ? this.prFailing.get(ref) : undefined;
        if (!!f === this.paused.has(ref)) continue;
        if (f) this.paused.add(ref);
        else this.paused.delete(ref);
        this.d.orchestrators.noteReadPaused?.(ref, f ? `paused: GitHub's rate limit refused the read of ${ref} (${f.why}); FF Factory keeps waiting and reads it again when the limit refills` : undefined);
      }
      const facts = this.facts(ci, pr, health);
      for (const w of blocked) {
        // One request that throws does not hold up the others (w1094: a throw ended the whole look).
        try {
          const live = this.d.store.work.get(w.id);
          if (!live || live.status !== 'blocked' || !live.blocked) continue;
          // Every gate (w754): the request starts only when all have cleared. One that is stuck or closed without delivering
          // decides it at once; the cleared ones are dropped as they clear.
          const gates = gatesOf(live).map((g) => ({ g, v: blockerVerdict(g, facts, live.id) }));
          const bad = gates.find((x) => x.v.state === 'stuck') ?? gates.find((x) => x.v.state === 'decide');
          const cleared = gates.filter((x) => x.v.state === 'clear');
          if (bad?.v.state === 'stuck') this.d.orchestrators.blockerStuck(live.id, bad.v.why, bad.g);
          else if (bad) this.d.orchestrators.blockerDecide(live.id, bad.v.why, bad.g);
          else if (cleared.length === gates.length) await this.clearAll(live, gates.map((x) => x.g), cleared.map((x) => x.v.why).join('; '), ci);
          else if (cleared.length) await this.clearSome(live, gates, cleared, ci);
          else continue;
          const was = bad ?? cleared[0];
          did.set(live.id, `${bad ? was.v.state : 'clear'}: ${(bad ? [bad] : cleared).map((x) => x.v.why).join('; ')}`);
        } catch (e) {
          console.warn(`blocker watch: ${w.id}: ${(e as Error).message}`);
        }
      }
      // w2357: a wait cycle (A Blocked on B, B Blocked on A) clears by itself never: the side that can act is resumed, and it
      // is logged. w2335 and its timed leg w2338 waited on each other until the 4-hourly unjam sweep found them.
      for (const cycle of waitCycles(this.d.store.work.values(), (w) => this.saysWaitsOn(w))) {
        try {
          const brk = cycleBreak(cycle, facts);
          const w = brk && this.d.store.work.get(brk.id.toLowerCase());
          if (!brk || !w || w.status !== 'blocked') continue;
          console.warn(`blocker watch: CYCLE: ${[...cycle, cycle[0]].join(' -> ')}: resuming ${brk.id} (${brk.why})`);
          if (gatesOf(w).length === 1) this.d.orchestrators.unblock(w.id, brk.why);
          else this.d.orchestrators.gatesCleared(w.id, [brk.gate], brk.why);
          did.set(w.id, `cycle: ${brk.why}`);
        } catch (e) {
          console.warn(`blocker watch: CYCLE: ${cycle.join(', ')}: ${(e as Error).message}`);
        }
      }
      for (const [id, why] of this.tellPrConflicts(health)) did.set(id, why);
      for (const [id, why] of this.flagDeadWaits()) did.set(id, why);
      // w1094, the backstop: a request still Blocked on CI that finished more than RESUME_SWEEP_MS ago (the clearing above
      // threw for it) is said loudly, once, and its CI gate is cleared again.
      const now = this.now();
      for (const [ref, state] of ci) {
        if (!state?.done) this.ciDoneAt.delete(ref);
        else if (!this.ciDoneAt.has(ref)) this.ciDoneAt.set(ref, now);
      }
      for (const w of this.d.store.work.values()) {
        if (w.status !== 'blocked') continue;
        const g = gatesOf(w).find((x) => x.kind === 'ci' && x.ref && now - (this.ciDoneAt.get(x.ref) ?? now) >= RESUME_SWEEP_MS);
        if (!g) continue;
        const text = ci.get(ciKey(g.ref!, g.head))?.text ?? `CI on ${g.ref} finished`;
        const key = `${w.id}@${g.ref}`;
        if (!this.swept.has(key)) console.warn(`blocker watch: SWEEP: ${w.id} is still Blocked on CI on ${g.ref}, which finished ${Math.round((now - this.ciDoneAt.get(g.ref!)!) / 60_000)} min ago (${text}); clearing it again`);
        this.swept.add(key);
        try {
          if (gatesOf(w).length === 1) this.d.orchestrators.unblock(w.id, text);
          else this.d.orchestrators.gatesCleared(w.id, [g], text);
          did.set(w.id, `sweep: cleared CI that finished: ${text}`);
        } catch (e) {
          console.warn(`blocker watch: SWEEP: ${w.id}: ${(e as Error).message}`);
        }
      }
      // w1094: a worker a gate's clearing resumed that never took the message is resumed again (Orchestrators.sweepResumes).
      const swept = this.d.orchestrators.sweepResumes?.((sid) => this.d.queued?.(sid) ?? false);
      if (swept) for (const [id, what] of swept) did.set(id, `sweep: ${what}`);
      // w1841: a worker whose report waits on a machine's bench lock, with nothing else to bring it back, is told it is free.
      for (const [id, what] of this.d.benchResume?.() ?? []) did.set(id, `bench: ${what}`);
      for (const [id, what] of this.d.awayMove?.() ?? []) did.set(id, `away: ${what}`);
      // Conditional decisions (w830): a person's "close it once #1314 merges", carried out or dropped when the fact is met.
      const decided = [...this.d.store.work.values()].filter((w) => w.conditional?.length);
      for (const w of decided) for (const c of w.conditional!) if (c.when.kind !== 'request_done' && !pr.has(c.when.ref)) pr.set(c.when.ref, await this.prOf(c.when.ref));
      const cfacts = { now: this.now(), work: (id: string) => this.d.store.work.get(id.toLowerCase()), pr: (ref: string) => pr.get(ref) };
      for (const w of decided) {
        for (const c of [...(this.d.store.work.get(w.id)?.conditional ?? [])]) {
          const v = conditionalVerdict(c, cfacts);
          if (v.state === 'wait') continue;
          if (v.state === 'run') this.d.orchestrators.carryOutConditional(w.id, c.id, v.why);
          else this.d.orchestrators.dropConditional(w.id, c.id, v.why);
          did.set(c.id, `${v.state}: ${v.why}`);
        }
      }
      // w2217: a request left undecided past the bound is offered to the dispatcher again, once. Not one of the blocked
      // requests this map is about: its log line and the journal say it.
      this.d.orchestrators.undecidedBound?.();
      // Timed work waiting on a computer that takes no timed runs (w1872): re-placed first, so the room flag below can start it.
      for (const id of this.d.orchestrators.replaceNoTimedWaits?.() ?? []) did.set(id, 're-placed: timed work off a computer that takes no timed runs');
      // A Queued timed leg (w1969, w2048, w2055): started on an idle computer, pre-empted onto a small one, or re-queued by priority.
      for (const id of this.d.orchestrators.timedLegBound?.() ?? []) did.set(id, 'timed leg: started, pre-empted or re-queued (w2055)');
      // A Steam pair run on a fleet short of computers signed in to Steam (w2459): Blocked on that, not Queued.
      for (const id of this.d.orchestrators.holdSteamPairs?.() ?? []) did.set(id, 'blocked: too few computers signed in to Steam for its pair run (w2459)');
      // Queued with room (w643): the same room test the page and decide_work queue read, for game work and for agent-slot work (w1098).
      const room: RoomNow | undefined = this.d.roomFacts?.() ?? (this.d.room ? { game: this.d.room(), agent: [], held: [] } : undefined);
      if (room && (room.game.length || room.agent.length || room.reserved?.length)) for (const id of this.d.orchestrators.flagQueuedWithRoom(room)) did.set(id, 'flagged: queued while a computer has room');
    } catch (e) {
      console.warn(`blocker watch: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    if (this.again) {
      this.again = false;
      this.kick();
    }
    return did;
  }

  /**
   * Every gate cleared: unblock, unless it is the merge-on-green pilot's (w2045) and its CI is green. Then FF Factory merges the
   * pull request itself at the head the worker pushed, and files the worker's report (Orchestrators.mergedOnGreen), with no
   * model turn. Red CI, a reading that is not green (unreadable, closed), or a merge GitHub refuses: unblocked as without it,
   * and the worker hears why.
   */
  private async clearAll(w: WorkItem, gates: readonly { kind: string; ref?: string; head?: string; mergeOnGreen?: { head: string } }[], why: string, ci: ReadonlyMap<string, CiState | undefined>) {
    const g = gates.length === 1 && gates[0].kind === 'ci' && gates[0].ref && gates[0].mergeOnGreen ? gates[0] : undefined;
    if (!g || !this.d.orchestrators.mergedOnGreen) return this.d.orchestrators.unblock(w.id, why);
    if (!ci.get(ciKey(g.ref!, g.head))?.green) return this.d.orchestrators.unblock(w.id, `${why}; FF Factory did not merge it (the checks are not all green), and the report you left with merge_on_green was not filed`);
    try {
      await (this.d.merge ? this.d.merge(g.ref!, g.mergeOnGreen!.head, this.d.githubPerson?.(w)) : ghMerge(g.ref!, g.mergeOnGreen!.head, ghRunner(this.d.githubPerson?.(w), `the merge of ${g.ref}`), this.d.evidenceScript));
    } catch (e) {
      const said = clipLine((e as Error).message, 1200);
      console.warn(`blocker watch: ${w.id}: merge on green of ${g.ref} failed: ${said}`);
      return this.d.orchestrators.unblock(w.id, `${why}; FF Factory tried to merge it: ${said}. Merge it yourself (ff-pr merge), then report; the report you left with merge_on_green was not filed`);
    }
    // Merged: the PR's state is read fresh next time.
    this.prSeen.delete(g.ref!);
    this.d.orchestrators.mergedOnGreen(w.id, why);
  }

  /**
   * Some gates cleared while others hold the request (w754). w2153: a gate a worker left with merge_on_green, the last of that
   * worker's own, is merged on green now and its report filed (DONE for its part), though another worker's gates (a pair
   * run's other leg) still hold the request: w2146's host leg left #2524's report at 14:20Z and lost it to the client leg's
   * wait at 14:22Z. The rest clear as before (gatesCleared, which resumes a worker whose own gates have all cleared).
   */
  private async clearSome(w: WorkItem, gates: readonly { g: WorkBlocker; v: { why: string } }[], cleared: readonly { g: WorkBlocker; v: { why: string } }[], ci: ReadonlyMap<string, CiState | undefined>) {
    const by = (g: WorkBlocker) => gateSetter(g);
    const merge = this.d.orchestrators.mergedOnGreen
      ? cleared.filter((x) => x.g.kind === 'ci' && x.g.ref && x.g.mergeOnGreen && ci.get(ciKey(x.g.ref, x.g.head))?.green && by(x.g) && gates.every((y) => by(y.g) !== by(x.g) || cleared.includes(y)))
      : [];
    const rest = cleared.filter((x) => !merge.includes(x));
    for (const x of merge) {
      const g = x.g;
      try {
        await (this.d.merge ? this.d.merge(g.ref!, g.mergeOnGreen!.head, this.d.githubPerson?.(w)) : ghMerge(g.ref!, g.mergeOnGreen!.head, ghRunner(this.d.githubPerson?.(w), `the merge of ${g.ref}`), this.d.evidenceScript));
      } catch (e) {
        const said = clipLine((e as Error).message, 1200);
        console.warn(`blocker watch: ${w.id}: merge on green of ${g.ref} failed: ${said}`);
        rest.push({ g, v: { why: `${x.v.why}; FF Factory tried to merge it: ${said}. Merge it yourself (ff-pr merge), then report; the report you left with merge_on_green was not filed` } });
        continue;
      }
      this.prSeen.delete(g.ref!);
      this.d.orchestrators.mergedOnGreen!(w.id, x.v.why, g);
    }
    if (rest.length) this.d.orchestrators.gatesCleared(w.id, rest.map((x) => x.g), rest.map((x) => x.v.why).join('; '));
  }

  /**
   * The request an open request's idle worker last said it waits on (w2357): its newest report's still-open line for it,
   * read as the ledger reads it (shared/workState.ts requestWaitOf). A busy worker is acting, so it waits on nothing yet.
   * Only a wait that holds now counts (w2371: w2338's report "waiting for w2335's worker to send its fix commit" kept
   * waking w2335 three times between 08:54Z and 08:56Z, after w2335 had pushed it and w2338 waited only for a sandbox):
   * none while a message to the worker waits in the send queue (it was answered, and waits for capacity), and none once
   * a worker of the request it names finished a turn after that report (it was resumed on it, and blocked again).
   */
  private saysWaitsOn(w: WorkItem): string | undefined {
    const s = newestFirst(w).map((sid) => this.d.store.sessions.get(sid)).find((x) => x?.kind === 'worker' && x.lastResult);
    if (!s || BUSY.has(s.status) || s.queuedSend) return undefined;
    const line = stillOpenIn(s.lastResult!).get(w.id.toLowerCase());
    const on = line ? requestWaitOf(line, w.id) : undefined;
    if (!on) return undefined;
    const said = Date.parse(s.lastResultAt ?? s.lastActivityAt) || 0;
    const t = this.d.store.work.get(on.toLowerCase());
    const actedSince = t?.sessionIds.some((sid) => {
      const x = this.d.store.sessions.get(sid);
      return x?.kind === 'worker' && (Date.parse(x.lastResultAt ?? '') || 0) > said;
    });
    return actedSince ? undefined : on;
  }

  private facts(ci: ReadonlyMap<string, CiState | undefined>, pr: ReadonlyMap<string, PrState | undefined>, health: ReadonlyMap<string, PrHealth | undefined>): BlockerFacts {
    const store = this.d.store;
    return {
      now: this.now(),
      work: (id) => store.work.get(id.toLowerCase()),
      reportedSince: (w: WorkItem, since: number, o?: { notCheckIn?: boolean }) =>
        w.sessionIds.some((sid) => {
          const s = store.sessions.get(sid);
          if (o?.notCheckIn && this.d.checkInPending?.(sid)) return false;
          return !!s && !BUSY.has(s.status) && !!s.lastResult && (Date.parse(s.lastActivityAt) || 0) > since;
        }),
      deliveredSince: (w: WorkItem, since: number, waiter?: string) => {
        // w2426: a pair run delivers through its host leg's result or every leg's DONE, never one client leg's turn end.
        if (w.pair) {
          const legs = (w.pair.started?.legs ?? []).map((l) => store.sessions.get(l.session));
          const fresh = legs.some((s) => !!s && !BUSY.has(s.status) && (Date.parse(s.lastActivityAt) || 0) > since);
          return fresh && pairDelivers(legs.map((s) => (s && !BUSY.has(s.status) ? s.lastResult : undefined)), w.id, waiter);
        }
        return w.sessionIds.some((sid) => {
          const s = store.sessions.get(sid);
          return !!s && !BUSY.has(s.status) && (Date.parse(s.lastActivityAt) || 0) > since && reportDelivers(s.lastResult, w.id, waiter);
        });
      },
      portalSha: this.d.portalSha?.(),
      // w2476: a worker that stopped after `since` with a final report on the request (no still-open line for it).
      workerEnded: (sid: string, since: number, workId: string) => {
        const s = store.sessions.get(sid);
        if (!s || BUSY.has(s.status) || !s.lastResult || (Date.parse(s.lastActivityAt) || 0) <= since || this.d.checkInPending?.(sid) || s.waitingOn) return undefined;
        return stillOpenIn(s.lastResult).has(workId.toLowerCase()) ? undefined : s.lastResult;
      },
      steamShort: (p) => steamShortIn(store.machines?.values() ?? [])(p),
      ...(this.d.daemonSha ? { daemonSha: this.d.daemonSha } : {}),
      ...(this.d.online ? { online: this.d.online } : {}),
      ...(this.d.paused ? { paused: this.d.paused } : {}),
      ...(this.d.usageClear ? { usageClear: this.d.usageClear } : {}),
      ...(this.d.disk ? { disk: this.d.disk } : {}),
      nightlyAt: this.d.nightlyAt?.(),
      ci: (ref, head) => ci.get(ciKey(ref, head)),
      ciUnreadable: (ref) => {
        const f = this.ciFailing.get(ref);
        return f && { since: f.since, why: f.why, ...(f.rateLimited ? { rateLimited: true } : {}) };
      },
      pr: (ref) => pr.get(ref),
      prHealth: (ref) => health.get(ref),
    };
  }

  /**
   * w3572: a pull request other requests wait to merge (a pr gate) conflicts with its base: those requests stay Blocked
   * (blockerVerdict wakes only the PR's owner, shared/blockers.ts ownsPr), and the requests that own it are told once per
   * head commit (Orchestrators.tellPrConflict). An owner Blocked on that PR itself (ci: or pr) is not told: its own gate
   * wakes it with the conflict. ffu#397 (w3445's) conflicted with main and w3423, w3416, w3419, w3421, w3422 and w3424, which
   * only waited for it to merge, were each woken to "merge main in, resolve, push", several times an hour.
   */
  private tellPrConflicts(health: ReadonlyMap<string, PrHealth | undefined>): [string, string][] {
    const did: [string, string][] = [];
    const all = [...this.d.store.work.values()];
    for (const [ref, h] of health) {
      if (h?.state !== 'open' || !h.conflict) continue;
      const key = `${ref}@${h.head ?? ''}`;
      if (this.conflictTold.has(key)) continue;
      const gated = (w: WorkItem) => w.status === 'blocked' && gatesOf(w).some((g) => (g.kind === 'pr' || g.kind === 'ci') && g.ref === ref);
      const waiters = all.filter((w) => gated(w) && !ownsPr(w, ref, h)).map((w) => w.id);
      if (!waiters.length) continue;
      const owners = all.filter((w) => isOpen(w) && ownsPr(w, ref, h));
      if (!owners.length) {
        console.log(`blocker watch: ${ref} conflicts with ${h.conflict.base}; ${waiters.join(', ')} wait for it to merge and no open request owns it (no Request: line, ledger link or branch), so nobody is told (w3572)`);
        this.conflictTold.add(key);
        continue;
      }
      let told = false;
      for (const o of owners) {
        if (gated(o)) { told = true; continue; }
        const text = `${prLabel(ref)} (${ref}) conflicts with ${h.conflict.base}, so it cannot merge and CI cannot run on it; ${waiters.join(', ')} wait for it to merge. It is ${o.id}'s: merge ${h.conflict.base} into its branch, resolve, push, and wait on its CI again. The requests waiting on it stay Blocked and do not touch it.`;
        try {
          if (this.d.orchestrators.tellPrConflict?.(o.id, { mark: `${ref} conflicts at ${(h.head ?? 'its head').slice(0, 7)}`, text })) did.push([o.id, `told: ${prLabel(ref)} conflicts with ${h.conflict.base} (w3572)`]);
          told = true;
        } catch (e) {
          console.warn(`blocker watch: ${o.id}: telling it ${ref} conflicts: ${(e as Error).message}`);
        }
      }
      if (told) this.conflictTold.add(key);
    }
    return did;
  }

  /**
   * A pull request's head and mergeability, read at most every CI_EVERY_MS (w907). A read that fails is logged as for CI
   * and answers undefined (no conflict is assumed). The first time a head commit is seen starts its no-CI-run clock.
   */
  private async healthOf(ref: string, person?: string): Promise<PrHealth | undefined> {
    const seen = this.healthSeen.get(ref);
    const now = this.now();
    if (seen && now - seen.at < this.every(person)) return seen.state;
    let state: PrHealth | undefined;
    let why = 'no answer';
    try {
      state = await (this.d.prHealth ? this.d.prHealth(ref, person) : ghPrHealth(ref, ghRunner(person, `the head of ${ref}`)));
    } catch (e) {
      why = clipLine((e as Error).message, 300);
    }
    if (state?.head) {
      const key = `${ref}@${state.head}`;
      if (!this.headFirstSeen.has(key)) this.headFirstSeen.set(key, now);
      state = { ...state, headSeenAt: this.headFirstSeen.get(key) };
      for (const [k, at] of this.headFirstSeen) if (now - at > 7 * 86_400_000) this.headFirstSeen.delete(k);
    }
    this.healthSeen.set(ref, { at: now, state });
    // A log line, not a warning: a failed head read only costs the conflict wake (the CI read itself is what warns, w829).
    this.noteRead(this.healthFailing, 'the head of', ref, now, state ? 'read' : undefined, why, console.log);
    return state;
  }

  /** A pull request's state, read at most every CI_EVERY_MS (w754). A read that fails is logged as for CI (w829). */
  private async prOf(ref: string, person?: string): Promise<PrState | undefined> {
    const seen = this.prSeen.get(ref);
    const now = this.now();
    if (seen && now - seen.at < this.every(person)) return seen.state;
    let state: PrState | undefined;
    let why = 'no answer';
    try {
      state = await (this.d.pr ? this.d.pr(ref, person) : ghPr(ref, ghRunner(person, `the state of ${ref}`)));
    } catch (e) {
      why = clipLine((e as Error).message, 300);
    }
    this.prSeen.set(ref, { at: now, state });
    this.noteRead(this.prFailing, 'the state of', ref, now, state?.text, why, console.warn, this.rateLimited(why, person));
    return state;
  }

  /**
   * Remembers and logs a read of a pull request that failed: the first time, every 30 minutes after, and when it reads
   * again (w829: CI reads failed in silence for hours).
   */
  private noteRead(failing: Map<string, Failing>, what: string, ref: string, now: number, read: string | undefined, why: string, warn: (line: string) => void = console.warn, rateLimited = false) {
    const was = failing.get(ref);
    if (read !== undefined) {
      if (was) console.log(`blocker watch: ${what} ${ref} reads again after ${Math.round((now - was.since) / 60_000)} min: ${read}`);
      failing.delete(ref);
    } else if (rateLimited) {
      // w3758: GitHub's rate limit, not the checks: a pause. Its clock starts again at each refused read, so the w829 rule
      // (unreadable for CI_UNREADABLE_MS: the worker looks) counts only failures after the limit refilled.
      if (!was?.rateLimited) warn(`blocker watch: ${what} ${ref} paused: GitHub's rate limit refuses it (${why}); the wait holds until it refills (w3758)`);
      failing.set(ref, { since: now, why, logged: was?.rateLimited ? was.logged : now, rateLimited: true });
    } else if (!was || was.rateLimited || now - was.logged >= READ_FAIL_LOG_MS) {
      warn(`blocker watch: cannot read ${what} ${ref}${was && !was.rateLimited ? ` (for ${Math.round((now - was.since) / 60_000)} min)` : ''}: ${why}`);
      failing.set(ref, { since: was && !was.rateLimited ? was.since : now, why, logged: now });
    } else failing.set(ref, { ...was, why });
  }

  /**
   * w3758: how often a person's pull requests are read now: every CI_EVERY_MS, or every GH_LOW_EVERY_MS while their token's
   * REST budget (as its last answer reported it) is below GH_LOW_REMAINING, so the portal leaves the rest to the workers' merges.
   */
  private every(person?: string): number {
    const b = budgetOf(person, this.now());
    return b && b.remaining < GH_LOW_REMAINING ? GH_LOW_EVERY_MS : CI_EVERY_MS;
  }

  /**
   * w3758 (w1186's rule): a failed read is GitHub's rate limit, never a missing permission or unreadable checks, when gh or
   * GitHub says so anywhere in it, or when the token's REST budget is spent: the GraphQL "Resource not accessible by personal
   * access token" on statusCheckRollup comes first in the words of every failed CI read under a fine-grained token, and
   * during exhaustion it hid "API rate limit exceeded" behind it (ffu#518 and FinalFactory#3469, 2026-11-08 23:39Z and 00:00Z).
   */
  private rateLimited(why: string, person?: string): boolean {
    return isRateLimitText(why) || budgetOf(person, this.now())?.remaining === 0;
  }

  /**
   * A pull request's checks, read at most every CI_EVERY_MS. A read that fails is remembered (ciUnreadable) and logged, the
   * first time and every 30 minutes after (w829: it failed in silence for hours), and so is its recovery.
   */
  private async ciOf(ref: string, person?: string, health?: PrHealth, head?: string): Promise<CiState | undefined> {
    const seen = this.ciSeen.get(ciKey(ref, head));
    const now = this.now();
    if (seen && now - seen.at < this.every(person)) return seen.state;
    let state: CiState | undefined;
    let why = 'no answer';
    const b = budgetOf(person, now);
    if (b?.remaining === 0) {
      // w3758: the budget is spent until it refills: a read now is refused for certain, so none is made.
      why = `GitHub's API rate limit exceeded (0 calls left; it refills at ${new Date(b.resetAt).toISOString().slice(11, 16)}Z)`;
    } else {
      try {
        const known = health?.head ? { state: health.state === 'merged' ? 'MERGED' : health.state === 'closed' ? 'CLOSED' : 'OPEN', head: health.head } : undefined;
        state = await (this.d.ci ? this.d.ci(ref, person, head) : ghChecks(ref, ghRunner(person, `CI on ${ref}`), this.d.online, { who: person, refused: this.refused, known, ...(head ? { head } : {}), now: () => this.now() }));
      } catch (e) {
        why = clipLine((e as Error).message, 300);
      }
    }
    this.ciSeen.set(ciKey(ref, head), { at: now, state });
    for (const [k, v] of this.ciSeen) if (now - v.at > 86_400_000) this.ciSeen.delete(k);
    this.noteRead(this.ciFailing, 'CI on', ref, now, state?.text, why, console.warn, !state && this.rateLimited(why, person));
    return state;
  }
}

type Failing = { since: number; why: string; logged: number; rateLimited?: true };

interface GhCheck {
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  conclusion?: string;
}

/** What a pull request's checks say (statusCheckRollup): done when none is still running, or the PR merged or closed. */
export function checksState(pr: { state?: string; statusCheckRollup?: GhCheck[] }, ref: string, away: readonly string[] = []): CiState {
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return { done: true, text: `${ref} is ${pr.state.toLowerCase()}` };
  // w3147: a leg queued on an away runner label (machine/awayRunners.ts) neither holds nor fails the verdict.
  const all = pr.statusCheckRollup ?? [];
  const checks = all.filter((c) => !isAwayLeg(c, away));
  const note = all.length > checks.length ? awayNote(all.length - checks.length, away) : '';
  const running = checks.filter((c) => (c.status ? c.status !== 'COMPLETED' : c.state === 'PENDING' || c.state === 'EXPECTED'));
  if (!checks.length) return { done: false, text: `${ref} has no checks yet`, none: true };
  const failed = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes((c.conclusion ?? c.state ?? '').toUpperCase()));
  // w3272: in a repository with away labels (ffu), a failed leg ends the wait at once, as the Actions-runs reading does.
  const failFast = failed.length > 0 && awayLabelsOf(CI_REF.exec(ref)?.[1] ?? '').length > 0;
  if (running.length && !failFast) return { done: false, text: `${running.length} of ${checks.length} checks on ${ref} still running` };
  return failed.length ? { done: true, text: `CI on ${ref} finished: ${failed.length} of ${checks.length} checks failed (${failed.slice(0, 3).map((c) => c.name ?? c.context).join(', ')})` } : { done: true, green: true, text: `CI on ${ref} finished: all ${checks.length} checks passed or skipped${note}` };
}

/** A pull request's merge state as REST gives it (GET /repos/{owner}/{repo}/pulls/{n}), with its head commit. */
export interface MergeState {
  mergeable_state?: string | null;
  head?: string;
}

/** Pull requests whose merge state this portal saw "unstable" (checks pending or failing), by "<ref>@<head sha>" (w889). */
const sawUnstable = new Map<string, number>();

/**
 * CI's end read from a pull request's merge state, the reading for a token that can read neither checks nor Actions runs
 * (w889; it needs only "Pull requests: read"). GitHub calls a PR "unstable" while a check is pending or failing and
 * "clean" (or "has_hooks") once every check passed (measured 2026-10-10 on Final-Factory/FinalFactory #1393, CI running:
 * unstable; #1387, CI green: clean). "clean" counts only after "unstable" was seen on the same head commit, so a PR whose
 * checks have not started yet is never taken for green. Running and failed CI look the same ("unstable"): undefined, and
 * the caller treats the checks as unreadable, so a red CI still clears after CI_UNREADABLE_MS.
 */
export function mergeStateCi(pr: MergeState, ref: string, seen: Map<string, number> = sawUnstable, now = Date.now()): CiState | undefined {
  const key = `${ref}@${pr.head ?? ''}`;
  const state = (pr.mergeable_state ?? '').toLowerCase();
  if (state === 'unstable') {
    seen.set(key, now);
    for (const [k, at] of seen) if (now - at > 7 * 86_400_000) seen.delete(k);
    return undefined;
  }
  if ((state === 'clean' || state === 'has_hooks') && seen.has(key)) {
    seen.delete(key);
    return { done: true, green: true, text: `CI on ${ref} finished: every check passed (read from the pull request's merge state, "${state}" after "unstable": FF Factory's GitHub token cannot read the checks themselves, docs/vault.md section 13.2)` };
  }
  return undefined;
}

interface GhRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
}

/**
 * What a commit's GitHub Actions runs say (GET /repos/{owner}/{repo}/actions/runs?head_sha=...), the reading for a token
 * without Checks permission (w829): done when none is still queued, waiting or in progress. A re-run is the same run back
 * in progress, so it counts as running again. w3786: with `head`, only runs at that commit count (a run whose head_sha is
 * another commit, an older push's, is left out), and the reading says it is of `head`.
 */
export function runsState(body: { workflow_runs?: GhRun[] }, ref: string, head?: string): CiState {
  const runs = (body.workflow_runs ?? []).filter((r) => !head || !r.head_sha || sameCommit(r.head_sha, head));
  const at = head ? { head } : {};
  if (!runs.length) return { done: false, text: `${ref} has no workflow runs yet${head ? ` at ${head.slice(0, 7)}` : ''}`, none: true, ...at };
  const running = runs.filter((r) => (r.status ?? '').toLowerCase() !== 'completed');
  if (running.length) return { done: false, text: `${running.length} of ${runs.length} workflow runs on ${ref} still running (${running.slice(0, 3).map((r) => r.name).join(', ')})`, ...at };
  const failed = runs.filter((r) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes((r.conclusion ?? '').toLowerCase()));
  const which = failed.slice(0, 3).map((r) => `${r.name}: ${r.conclusion}`).join(', ');
  return failed.length ? { done: true, failed: which, text: `CI on ${ref} finished: ${failed.length} of ${runs.length} workflow runs failed (${which})`, ...at } : { done: true, green: true, text: `CI on ${ref} finished: all ${runs.length} workflow runs passed or skipped`, ...at };
}

const clipLine = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** What a pull request says about itself (gh pr view): open, merged, or closed without merging (w754). */
export function prState(pr: { state?: string; mergeCommit?: { oid?: string } | null }, ref: string): PrState {
  if (pr.state === 'MERGED') return { state: 'merged', text: `${ref} merged`, ...(pr.mergeCommit?.oid ? { sha: pr.mergeCommit.oid } : {}) };
  if (pr.state === 'CLOSED') return { state: 'closed', text: `${ref} was closed without merging` };
  return { state: 'open', text: `${ref} is still open` };
}

/** What `gh pr view` says for a pull request's health (w907): its state, GitHub's mergeability, base branch and head commit. */
export function prHealthOf(pr: { state?: string; mergeable?: string; baseRefName?: string; headRefOid?: string; headRefName?: string; body?: string }): PrHealth {
  const requests = requestIdsIn(pr.body ?? '');
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open';
  return {
    state,
    ...(pr.mergeable === 'CONFLICTING' ? { conflict: { base: pr.baseRefName || 'its base branch' } } : {}),
    ...(pr.headRefOid ? { head: pr.headRefOid } : {}),
    ...(pr.headRefName ? { headRef: pr.headRefName } : {}),
    ...(requests.length ? { requests } : {}),
  };
}

/**
 * A pull request's health through gh (Pull requests: read only; no checks, no Actions). `mergeable` is UNKNOWN for a
 * moment after a push while GitHub works it out: that reads as no conflict, and the next read decides.
 */
export async function ghPrHealth(ref: string, run: Runner = runProc): Promise<PrHealth> {
  const m = CI_REF.exec(ref);
  if (!m) throw new Error(`"${ref}" is not a pull request (owner/repo#123)`);
  const r = await run('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'state,mergeable,baseRefName,headRefOid,headRefName,body'], { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (r.code !== 0) throw new Error(`gh pr view ${ref}: ${ghSaid(r)}`);
  return prHealthOf(JSON.parse(r.stdout) as Parameters<typeof prHealthOf>[0]);
}

/** A pull request's state through gh; throws, saying what gh said, when it cannot be read (w829). */
export async function ghPr(ref: string, run: Runner = runProc): Promise<PrState> {
  const m = CI_REF.exec(ref);
  if (!m) throw new Error(`"${ref}" is not a pull request (owner/repo#123)`);
  const r = await run('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'state,mergeCommit'], { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (r.code !== 0) throw new Error(`gh pr view ${ref}: ${ghSaid(r)}`);
  return prState(JSON.parse(r.stdout) as { state?: string; mergeCommit?: { oid?: string } | null }, ref);
}

type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** What a failed gh call said, on one line. */
const ghSaid = (r: RunResult) => clipLine(r.stderr || r.stdout || `exit ${r.code}`, 200);

/** Logged once per server: statusCheckRollup is refused, so CI is read from Actions runs (w829). */
let rollupRefusedLogged = false;

/**
 * A pull request's checks through gh. statusCheckRollup first (it covers every check and status). Where GitHub refuses it
 * (w829: the portal's gh logs in with a fine-grained token, docs/portal-on-ffbox-host.md D7, and GitHub gives those no
 * Checks permission, so every read failed and the CI blocks of w814, w818 and w808 never cleared), the PR's state and its
 * head commit's GitHub Actions runs, which "Actions: read" covers. Throws, saying what gh said, when neither can be read.
 */
/**
 * w2045: `gh pr merge` at exactly `head` (a newer push, or one GitHub's rules refuse, is not merged). Throws with what gh said.
 * w3021: GitHub refuses a short sha there ("Could not coerce value "3e14de3aa516" to GitObjectID", ffu#200), so a short head
 * is first resolved to the pull request's own head commit, and only when that commit starts with it: a head that moved
 * since the worker recorded it is never merged.
 */
export async function ghMerge(ref: string, head: string, run: Runner = runProc, evidenceScript: () => string | undefined | Promise<string | undefined> = findLocalPrEvidence): Promise<void> {
  const m = CI_REF.exec(ref);
  if (!m) throw new Error(`"${ref}" is not a pull request (owner/repo#123)`);
  const opts = { timeoutMs: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } };
  let full = head.trim().toLowerCase();
  if (!FULL_SHA.test(full)) {
    if (!/^[0-9a-f]{7,39}$/.test(full)) throw new Error(`gh pr merge ${ref}: not merged: "${head}" is not a commit sha`);
    const p = await run('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'headRefOid'], opts);
    if (p.code !== 0) throw new Error(`gh pr merge ${ref}: not merged: its head commit, to resolve ${full}, cannot be read: ${ghSaid(p)}`);
    const oid = String((JSON.parse(p.stdout) as { headRefOid?: string }).headRefOid ?? '').toLowerCase();
    if (!FULL_SHA.test(oid) || !oid.startsWith(full)) throw new Error(`gh pr merge ${ref}: not merged: its head is ${oid.slice(0, 12) || 'unknown'}, not ${full}, the commit recorded to merge`);
    full = oid;
  }
  // w3088: in a gated repository the pilot merges only what pr_evidence.py passes, as ff-pr merge does (machine/evidenceGate.ts):
  // #3180 merged on green with its Evidence section failing. Through the same runner, so the script's own gh calls carry the
  // person's token. No script, no python, a FAIL or a usage error: not merged, and the worker hears the failing lines.
  if (evidenceGated(m[1])) {
    const script = await evidenceScript();
    if (!script) throw new Error(`not merged: ${noScriptRefusal(m[1], m[2])}`);
    // w3190: the game repo's HUD pins, which the script reads from a game checkout; the portal has none (machine/evidenceGate.ts fetchHudData).
    const hud = await fetchHudData(m[1], m[2], run, opts);
    if (hud && 'error' in hud) throw new Error(`not merged: the Evidence check could not run for ${m[1]}#${m[2]}: ${hud.error}`);
    const env = hud ? { ...opts.env, FF_HUD_DATA: hud.dir } : opts.env;
    const e = await run(evidencePython(), evidenceArgs(script, m[1], m[2]), { ...opts, env, timeoutMs: 5 * 60_000 });
    const v = evidenceVerdict(e.code, e.stdout, e.stderr);
    if (!v.ok) throw new Error(`not merged: ${evidenceRefusal(m[1], m[2], e.code, v)}`);
  }
  const r = await run('gh', ['pr', 'merge', m[2], '-R', m[1], '--merge', '--match-head-commit', full], opts);
  if (r.code !== 0) throw new Error(`gh pr merge ${ref}: ${ghSaid(r)}`);
}

/**
 * w3758: what one portal saves between reads of a pull request's checks, so each read spends as little of the token's hourly
 * REST budget as it can: the refusals that do not change (a fine-grained token is refused statusCheckRollup and the runner
 * list every time: one GraphQL and one REST call per read, every two minutes, per gate), each remembered for REFUSED_FOR_MS
 * and then tried again, and the credential (`who`) its conditional reads are cached by (server/ghBudget.ts ghGet).
 */
export interface CheckReads {
  who?: string;
  refused: Map<string, number>;
  /** The pull request's state and head as the watch just read them (its health read): no second `gh pr view` for them. */
  known?: { state?: string; head?: string };
  /**
   * w3786: the commit the wait is for (its gate's head, what the worker pushed). Only that commit's checks or runs are read:
   * a pull request whose head is still another commit, as a cached or lagging read says straight after a push, is CI not
   * started yet, never the old head's verdict.
   */
  head?: string;
  now?: () => number;
}

/** w3786: what a reading at another commit than the wait's says: CI at the wait's head has not been read yet, so it holds. */
function notAtHead(ref: string, head: string, at: string | undefined): CiState {
  return { done: false, head: at, text: `${ref}'s head reads ${(at ?? 'unknown').slice(0, 7)}, not ${head.slice(0, 7)} (the commit waited on): CI at ${head.slice(0, 7)} is not read yet` };
}
/** How long a refusal that does not change is remembered before it is tried again (a token given the permission is seen within it). */
export const REFUSED_FOR_MS = 60 * 60_000;
const refusedNow = (c: CheckReads | undefined, key: string) => !!c && (c.refused.get(`${c.who ?? 'portal'} ${key}`) ?? 0) > (c.now?.() ?? Date.now());
const noteRefused = (c: CheckReads | undefined, key: string) => c?.refused.set(`${c.who ?? 'portal'} ${key}`, (c.now?.() ?? Date.now()) + REFUSED_FOR_MS);
/** A refusal for want of a permission, never a rate limit (w1186) or a failure to reach GitHub. */
const permissionRefusal = (r: RunResult) => r.code !== 0 && /Resource not accessible|HTTP 403/i.test(`${r.stderr}${r.stdout}`) && !isRateLimitText(`${r.stderr}${r.stdout}`);

export async function ghChecks(ref: string, run: Runner = runProc, online?: (machineId: string) => boolean | undefined, reads?: CheckReads): Promise<CiState> {
  const m = CI_REF.exec(ref);
  if (!m) throw new Error(`"${ref}" is not a pull request (owner/repo#123)`);
  const opts = { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } };
  const get = (path: string) => ghGet(run, path, opts, reads?.who);
  const want = reads?.head?.trim().toLowerCase() || undefined;
  const away = await awayNow(m[1], run, opts, online, reads);
  const rollupKey = `${m[1]} statusCheckRollup`;
  // w3758: a rollup this credential was refused is not asked for again until REFUSED_FOR_MS has passed.
  const r: RunResult = refusedNow(reads, rollupKey)
    ? { code: 1, stdout: '', stderr: 'statusCheckRollup: refused to this token (remembered, w3758)' }
    : await run('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'state,statusCheckRollup,headRefOid'], opts);
  if (r.code === 0) {
    const pr = JSON.parse(r.stdout) as { state?: string; statusCheckRollup?: GhCheck[]; headRefOid?: string };
    // w3786: a rollup of another commit than the one waited on (GitHub not caught up with the push yet, or a later push)
    // says nothing of the wait's CI: that commit's own runs are read instead.
    if (want && pr.state !== 'MERGED' && pr.state !== 'CLOSED' && !sameCommit(pr.headRefOid, want)) return runsAtHead(ref, m[1], want, pr.headRefOid, away, get);
    const s = { ...checksState(pr, ref, away), ...(pr.headRefOid ? { head: pr.headRefOid } : {}) };
    return s.none && pr.headRefOid ? queuedRunsOr(s, ref, m[1], pr.headRefOid, get) : s;
  }
  if (permissionRefusal(r)) noteRefused(reads, rollupKey);
  let pr: { state?: string; headRefOid?: string };
  if (reads?.known?.head && reads.known.state) pr = { state: reads.known.state, headRefOid: reads.known.head };
  else {
    const p = await run('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'state,headRefOid'], opts);
    if (p.code !== 0) throw new Error(`gh pr view ${ref}: ${ghSaid(p)}`);
    pr = JSON.parse(p.stdout) as { state?: string; headRefOid?: string };
  }
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return checksState(pr, ref);
  if (!pr.headRefOid) throw new Error(`gh pr view ${ref} gave no head commit; its checks: ${ghSaid(r)}`);
  // w3786: the runs of the commit waited on, whatever head the (possibly cached) health read gave.
  const a = await get(`repos/${m[1]}/actions/runs?head_sha=${want ?? pr.headRefOid}&per_page=100`);
  if (a.code !== 0) {
    // w889: the last reading, the PR's merge state (Pull requests: read), which tells a green finish from a running CI.
    const ms = await get(`repos/${m[1]}/pulls/${m[2]}`);
    const said = `its checks: ${ghSaid(r)}; its Actions runs: ${ghSaid(a)}`;
    if (ms.code !== 0) throw new Error(`${said}; its merge state: ${ghSaid(ms)}`);
    const pull = JSON.parse(ms.stdout) as { mergeable_state?: string; head?: { sha?: string } | string };
    const state: MergeState = { mergeable_state: pull.mergeable_state, head: typeof pull.head === 'string' ? pull.head : pull.head?.sha };
    if (want && !sameCommit(state.head, want)) return notAtHead(ref, want, state.head);
    const green = mergeStateCi(state, ref);
    if (green) return { ...green, ...(state.head ? { head: state.head } : {}) };
    throw new Error(`${said}; its merge state: ${state.mergeable_state ?? 'unknown'} (pending or failed checks cannot be told apart from it)`);
  }
  if (!rollupRefusedLogged) {
    rollupRefusedLogged = true;
    console.warn(`blocker watch: gh cannot read pull requests' checks (${ghSaid(r)}); CI blocks read their GitHub Actions runs instead`);
  }
  const body = JSON.parse(a.stdout) as { workflow_runs?: (GhRun & { id?: number })[] };
  const settled = await settleAwayRuns(m[1], body.workflow_runs ?? [], away, get);
  const s = runsState({ workflow_runs: body.workflow_runs }, ref, want ?? pr.headRefOid);
  return settled && s.green ? { ...s, text: s.text + awayNote(settled, away) } : s;
}

/**
 * w3786: CI at `head`, the commit a wait is for, read from its own Actions runs when the pull request reads another head
 * (`at`). No run at it, or runs that cannot be read, hold the wait (notAtHead), never the other head's verdict.
 */
async function runsAtHead(ref: string, repo: string, head: string, at: string | undefined, away: readonly string[], get: (path: string) => Promise<RunResult>): Promise<CiState> {
  const a = await get(`repos/${repo}/actions/runs?head_sha=${head}&per_page=100`);
  if (a.code !== 0) return notAtHead(ref, head, at);
  let runs: (GhRun & { id?: number })[];
  try {
    runs = (JSON.parse(a.stdout) as { workflow_runs?: (GhRun & { id?: number })[] }).workflow_runs ?? [];
  } catch {
    return notAtHead(ref, head, at);
  }
  runs = runs.filter((r) => !r.head_sha || sameCommit(r.head_sha, head));
  if (!runs.length) return { ...notAtHead(ref, head, at), none: true };
  const settled = await settleAwayRuns(repo, runs, away, get);
  const s = runsState({ workflow_runs: runs }, ref, head);
  return settled && s.green ? { ...s, text: s.text + awayNote(settled, away) } : s;
}

/**
 * w3527: a pull request with no check runs may still have a workflow run for its head: a run "pending" on a concurrency
 * group or "queued" for a busy self-hosted runner has no jobs yet, so no check runs (measured 2026-11-08 on
 * Final-Factory/ffu#433: run 42435334681 status "pending", zero jobs, an empty rollup for 15+ min). Such a run is CI that
 * exists and is pending, never "no CI run" (w3504's worker was woken four times in 20 minutes by that clear). When the
 * runs cannot be read, the rollup's answer stands.
 */
async function queuedRunsOr(none: CiState, ref: string, repo: string, head: string, get: (path: string) => Promise<RunResult>): Promise<CiState> {
  const a = await get(`repos/${repo}/actions/runs?head_sha=${head}&per_page=100`);
  if (a.code !== 0) return none;
  let runs: (GhRun & { id?: number })[];
  try {
    runs = (JSON.parse(a.stdout) as { workflow_runs?: (GhRun & { id?: number })[] }).workflow_runs ?? [];
  } catch {
    return none;
  }
  const q = queuedRunsState(runs, ref);
  return q ? { ...q, head } : none;
}

/** w3527: what a head's workflow runs say when its pull request has no check runs yet: pending while any is unfinished; undefined when it has none or all finished (the rollup's "no checks" stands). */
export function queuedRunsState(runs: (GhRun & { id?: number })[], ref: string): CiState | undefined {
  const open = runs.filter((r) => (r.status ?? '').toLowerCase() !== 'completed');
  if (!open.length) return undefined;
  const which = open.slice(0, 3).map((r) => `${r.name ?? 'a run'}${r.id ? ` (run ${r.id})` : ''} ${(r.status ?? 'queued').toLowerCase()}`).join(', ');
  return { done: false, text: `${open.length} of ${runs.length} workflow runs on ${ref} waiting to start, no jobs picked up yet: ${which}` };
}

/** w3147: the away labels (machine/awayRunners.ts) of `repo` whose runners are all offline now; when the runner list is unreadable, those whose FF Factory machine is offline. */
async function awayNow(repo: string, run: Runner, opts: RunOptions, online?: (machineId: string) => boolean | undefined, reads?: CheckReads): Promise<readonly string[]> {
  const labels = awayLabelsOf(repo);
  if (!labels.length) return [];
  // w3758: a runner list this credential was refused is not asked for again until REFUSED_FOR_MS has passed (one REST call a read).
  const key = `${repo} runners`;
  if (refusedNow(reads, key)) return offlineByMachine(labels, online);
  const r = await ghGet(run, `repos/${repo}/actions/runners?per_page=100`, opts, reads?.who);
  // The runner list needs Administration: read, which the portal's tokens lack: then FF Factory's own link to the machine.
  if (r.code !== 0) {
    if (permissionRefusal(r)) noteRefused(reads, key);
    return offlineByMachine(labels, online);
  }
  try {
    return offlineLabels(JSON.parse(r.stdout) as Parameters<typeof offlineLabels>[0], labels);
  } catch {
    return offlineByMachine(labels, online);
  }
}

/**
 * w3147: mark each unfinished run that waits only on away legs as a green finish, in place; answers how many away legs it
 * skipped. w3272: and each unfinished run with a failed leg as a red one, whether or not a label is away now.
 */
async function settleAwayRuns(repo: string, runs: (GhRun & { id?: number })[], away: readonly string[], get: (path: string) => Promise<RunResult>): Promise<number> {
  if (!awayLabelsOf(repo).length) return 0;
  let legs = 0;
  for (const w of runs) {
    if ((w.status ?? '').toLowerCase() === 'completed' || !w.id) continue;
    const j = await get(`repos/${repo}/actions/runs/${w.id}/jobs?per_page=100`);
    if (j.code !== 0) continue;
    let jobs: Leg[];
    try {
      jobs = (JSON.parse(j.stdout) as { jobs?: Leg[] }).jobs ?? [];
    } catch {
      continue;
    }
    const s = settleJobs(jobs, away);
    if (!s) continue;
    w.status = 'completed';
    w.conclusion = s.conclusion;
    if (s.conclusion === 'failure') w.name = `${w.name ?? w.id}${failedNote(s.failed)}`;
    else legs += s.legs;
  }
  return legs;
}
