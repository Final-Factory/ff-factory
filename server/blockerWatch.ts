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
// It also flags requests queued for capacity while a computer that could take them has room (flagQueuedWithRoom).
// A deploy blocker the ledger cleanup set itself (a merged request whose only step left is a deploy) is the cleanup's:
// it closes the request when the deploy runs the merge (server/ledgerSweep.ts), so this watch leaves it alone.
import type { Store } from './store.ts';
import type { Orchestrators } from './orchestrators.ts';
import { run as runProc, type RunOptions, type RunResult } from './proc.ts';
import { blockerVerdict, CI_REF, gatesOf, type BlockerFacts, type PrHealth } from '../shared/blockers.ts';
import { conditionalVerdict } from '../shared/conditional.ts';
import { ghRunner } from './githubTokens.ts';
import type { SessionInfo, WorkItem } from '../shared/types.ts';

const EVERY_MS = 60_000;
/**
 * A pull request's checks are read at most this often each (gh; GitHub's rate limit is 5000 calls an hour, and a read is
 * 1 call, 3 where the checks are refused: 10 gates cost at most 900 an hour). Two minutes (w846, was 5): a worker waiting
 * on CI is resumed within about 4 minutes of its checks finishing (2 to read, 1 for the watch, 1 for its check-in).
 */
const CI_EVERY_MS = 2 * 60_000;
/** A pull request that cannot be read is logged when it starts failing and again this often while it does (w829). */
const READ_FAIL_LOG_MS = 30 * 60_000;
const BUSY: ReadonlySet<SessionInfo['status']> = new Set(['running', 'starting', 'waiting_permission']);

/** `none`: no check or workflow run exists for the pull request's head yet (w907: it may never get one). */
export type CiState = { done: boolean; text: string; none?: boolean };
/** A pull request's state (w754): open, merged, or closed without merging, and a line saying how. */
export type PrState = { state: 'open' | 'merged' | 'closed'; text: string; sha?: string };

export interface BlockerWatchDeps {
  store: Store;
  orchestrators: Pick<Orchestrators, 'unblock' | 'blockerStuck' | 'blockerDecide' | 'gatesCleared' | 'flagQueuedWithRoom' | 'carryOutConditional' | 'dropConditional'>;
  /** The commit the portal runs. */
  portalSha?: () => string | undefined;
  /** The commit a machine's daemon runs. */
  daemonSha?: (machineId: string) => string | undefined;
  /** Whether a machine is online; undefined for one this portal does not have. */
  online?: (machineId: string) => boolean | undefined;
  /** Whether a Claude account's meters are clear (by its email or label); undefined when unknown. */
  usageClear?: (account: string) => boolean | undefined;
  /** When the nightly lab last posted its results (ms). */
  nightlyAt?: () => number | undefined;
  /**
   * A pull request's checks ("owner/repo#123"); default gh, on the GitHub token of `person` (the person the first request
   * waiting on it is for, w868; server/githubTokens.ts). Throws (or answers undefined) when they cannot be read.
   */
  ci?: (ref: string, person?: string) => Promise<CiState | undefined>;
  /** A pull request's head and mergeability ("owner/repo#123", w907); default gh, as for ci. */
  prHealth?: (ref: string, person?: string) => Promise<PrHealth | undefined>;
  /** A pull request's state ("owner/repo#123"); default gh, as for ci. */
  pr?: (ref: string, person?: string) => Promise<PrState | undefined>;
  /** Whose GitHub token a request's reads use (w868); undefined: the portal's own gh login. */
  githubPerson?: (w: WorkItem) => string | undefined;
  /** The computers with room for one more worker now. */
  room?: () => string[];
  now?: () => number;
}

export class BlockerWatch {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private again = false;
  private readonly ciSeen = new Map<string, { at: number; state?: CiState }>();
  /** w829: pull requests whose checks could not be read: since when, why, and when that was last logged. */
  private readonly ciFailing = new Map<string, { since: number; why: string; logged: number }>();
  private readonly healthSeen = new Map<string, { at: number; state?: PrHealth }>();
  /** "<ref>@<head sha>" to when this portal first saw that head (w907: the clock of the no-CI-run rule). */
  private readonly headFirstSeen = new Map<string, number>();
  private readonly prSeen = new Map<string, { at: number; state?: PrState }>();
  private readonly healthFailing = new Map<string, { since: number; why: string; logged: number }>();
  private readonly prFailing = new Map<string, { since: number; why: string; logged: number }>();
  private readonly d: BlockerWatchDeps;

  constructor(d: BlockerWatchDeps) {
    this.d = d;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
    this.timer.unref?.();
    return this;
  }

  close() {
    clearInterval(this.timer);
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
      const blocked = [...this.d.store.work.values()].filter((w) => w.status === 'blocked' && w.blocked && w.blocked.by !== 'ledger cleanup');
      const ci = new Map<string, CiState | undefined>();
      const pr = new Map<string, PrState | undefined>();
      const health = new Map<string, PrHealth | undefined>();
      for (const w of blocked) {
        for (const g of gatesOf(w)) {
          if (!g.ref) continue;
          // A pull request several requests wait on is read once, on the first one's person's token.
          if (g.kind === 'ci' && !ci.has(g.ref)) ci.set(g.ref, await this.ciOf(g.ref, this.d.githubPerson?.(w)));
          else if (g.kind === 'pr' && !pr.has(g.ref)) pr.set(g.ref, await this.prOf(g.ref, this.d.githubPerson?.(w)));
          // w907: its head and mergeability, for a ci gate and for a pr gate its worker set itself.
          if ((g.kind === 'ci' || (g.kind === 'pr' && g.by.startsWith('worker '))) && !health.has(g.ref)) health.set(g.ref, await this.healthOf(g.ref, this.d.githubPerson?.(w)));
        }
      }
      const facts = this.facts(ci, pr, health);
      for (const w of blocked) {
        const live = this.d.store.work.get(w.id);
        if (!live || live.status !== 'blocked' || !live.blocked) continue;
        // Every gate (w754): the request starts only when all have cleared. One that is stuck or closed without delivering
        // decides it at once; the cleared ones are dropped as they clear.
        const gates = gatesOf(live).map((g) => ({ g, v: blockerVerdict(g, facts) }));
        const bad = gates.find((x) => x.v.state === 'stuck') ?? gates.find((x) => x.v.state === 'decide');
        const cleared = gates.filter((x) => x.v.state === 'clear');
        if (bad?.v.state === 'stuck') this.d.orchestrators.blockerStuck(live.id, bad.v.why, bad.g);
        else if (bad) this.d.orchestrators.blockerDecide(live.id, bad.v.why, bad.g);
        else if (cleared.length === gates.length) this.d.orchestrators.unblock(live.id, cleared.map((x) => x.v.why).join('; '));
        else if (cleared.length) this.d.orchestrators.gatesCleared(live.id, cleared.map((x) => x.g), cleared.map((x) => x.v.why).join('; '));
        else continue;
        const was = bad ?? cleared[0];
        did.set(live.id, `${bad ? was.v.state : 'clear'}: ${(bad ? [bad] : cleared).map((x) => x.v.why).join('; ')}`);
      }
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
      const room = this.d.room?.();
      if (room?.length) for (const id of this.d.orchestrators.flagQueuedWithRoom(room)) did.set(id, 'flagged: queued while a computer has room');
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

  private facts(ci: ReadonlyMap<string, CiState | undefined>, pr: ReadonlyMap<string, PrState | undefined>, health: ReadonlyMap<string, PrHealth | undefined>): BlockerFacts {
    const store = this.d.store;
    return {
      now: this.now(),
      work: (id) => store.work.get(id.toLowerCase()),
      reportedSince: (w: WorkItem, since: number) =>
        w.sessionIds.some((sid) => {
          const s = store.sessions.get(sid);
          return !!s && !BUSY.has(s.status) && !!s.lastResult && (Date.parse(s.lastActivityAt) || 0) > since;
        }),
      portalSha: this.d.portalSha?.(),
      ...(this.d.daemonSha ? { daemonSha: this.d.daemonSha } : {}),
      ...(this.d.online ? { online: this.d.online } : {}),
      ...(this.d.usageClear ? { usageClear: this.d.usageClear } : {}),
      nightlyAt: this.d.nightlyAt?.(),
      ci: (ref) => ci.get(ref),
      ciUnreadable: (ref) => {
        const f = this.ciFailing.get(ref);
        return f && { since: f.since, why: f.why };
      },
      pr: (ref) => pr.get(ref),
      prHealth: (ref) => health.get(ref),
    };
  }

  /**
   * A pull request's head and mergeability, read at most every CI_EVERY_MS (w907). A read that fails is logged as for CI
   * and answers undefined (no conflict is assumed). The first time a head commit is seen starts its no-CI-run clock.
   */
  private async healthOf(ref: string, person?: string): Promise<PrHealth | undefined> {
    const seen = this.healthSeen.get(ref);
    const now = this.now();
    if (seen && now - seen.at < CI_EVERY_MS) return seen.state;
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
    if (seen && now - seen.at < CI_EVERY_MS) return seen.state;
    let state: PrState | undefined;
    let why = 'no answer';
    try {
      state = await (this.d.pr ? this.d.pr(ref, person) : ghPr(ref, ghRunner(person, `the state of ${ref}`)));
    } catch (e) {
      why = clipLine((e as Error).message, 300);
    }
    this.prSeen.set(ref, { at: now, state });
    this.noteRead(this.prFailing, 'the state of', ref, now, state?.text, why);
    return state;
  }

  /**
   * Remembers and logs a read of a pull request that failed: the first time, every 30 minutes after, and when it reads
   * again (w829: CI reads failed in silence for hours).
   */
  private noteRead(failing: Map<string, { since: number; why: string; logged: number }>, what: string, ref: string, now: number, read: string | undefined, why: string, warn: (line: string) => void = console.warn) {
    const was = failing.get(ref);
    if (read !== undefined) {
      if (was) console.log(`blocker watch: ${what} ${ref} reads again after ${Math.round((now - was.since) / 60_000)} min: ${read}`);
      failing.delete(ref);
    } else if (!was || now - was.logged >= READ_FAIL_LOG_MS) {
      warn(`blocker watch: cannot read ${what} ${ref}${was ? ` (for ${Math.round((now - was.since) / 60_000)} min)` : ''}: ${why}`);
      failing.set(ref, { since: was?.since ?? now, why, logged: now });
    } else failing.set(ref, { ...was, why });
  }

  /**
   * A pull request's checks, read at most every CI_EVERY_MS. A read that fails is remembered (ciUnreadable) and logged, the
   * first time and every 30 minutes after (w829: it failed in silence for hours), and so is its recovery.
   */
  private async ciOf(ref: string, person?: string): Promise<CiState | undefined> {
    const seen = this.ciSeen.get(ref);
    const now = this.now();
    if (seen && now - seen.at < CI_EVERY_MS) return seen.state;
    let state: CiState | undefined;
    let why = 'no answer';
    try {
      state = await (this.d.ci ? this.d.ci(ref, person) : ghChecks(ref, ghRunner(person, `CI on ${ref}`)));
    } catch (e) {
      why = clipLine((e as Error).message, 300);
    }
    this.ciSeen.set(ref, { at: now, state });
    this.noteRead(this.ciFailing, 'CI on', ref, now, state?.text, why);
    return state;
  }
}

interface GhCheck {
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  conclusion?: string;
}

/** What a pull request's checks say (statusCheckRollup): done when none is still running, or the PR merged or closed. */
export function checksState(pr: { state?: string; statusCheckRollup?: GhCheck[] }, ref: string): CiState {
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return { done: true, text: `${ref} is ${pr.state.toLowerCase()}` };
  const checks = pr.statusCheckRollup ?? [];
  const running = checks.filter((c) => (c.status ? c.status !== 'COMPLETED' : c.state === 'PENDING' || c.state === 'EXPECTED'));
  if (!checks.length) return { done: false, text: `${ref} has no checks yet`, none: true };
  if (running.length) return { done: false, text: `${running.length} of ${checks.length} checks on ${ref} still running` };
  const failed = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes((c.conclusion ?? c.state ?? '').toUpperCase()));
  return { done: true, text: failed.length ? `CI on ${ref} finished: ${failed.length} of ${checks.length} checks failed (${failed.slice(0, 3).map((c) => c.name ?? c.context).join(', ')})` : `CI on ${ref} finished: all ${checks.length} checks passed or skipped` };
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
    return { done: true, text: `CI on ${ref} finished: every check passed (read from the pull request's merge state, "${state}" after "unstable": FF Factory's GitHub token cannot read the checks themselves, docs/vault.md section 13.2)` };
  }
  return undefined;
}

interface GhRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

/**
 * What a commit's GitHub Actions runs say (GET /repos/{owner}/{repo}/actions/runs?head_sha=...), the reading for a token
 * without Checks permission (w829): done when none is still queued, waiting or in progress. A re-run is the same run back
 * in progress, so it counts as running again.
 */
export function runsState(body: { workflow_runs?: GhRun[] }, ref: string): CiState {
  const runs = body.workflow_runs ?? [];
  if (!runs.length) return { done: false, text: `${ref} has no workflow runs yet`, none: true };
  const running = runs.filter((r) => (r.status ?? '').toLowerCase() !== 'completed');
  if (running.length) return { done: false, text: `${running.length} of ${runs.length} workflow runs on ${ref} still running (${running.slice(0, 3).map((r) => r.name).join(', ')})` };
  const failed = runs.filter((r) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes((r.conclusion ?? '').toLowerCase()));
  return { done: true, text: failed.length ? `CI on ${ref} finished: ${failed.length} of ${runs.length} workflow runs failed (${failed.slice(0, 3).map((r) => `${r.name}: ${r.conclusion}`).join(', ')})` : `CI on ${ref} finished: all ${runs.length} workflow runs passed or skipped` };
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
export function prHealthOf(pr: { state?: string; mergeable?: string; baseRefName?: string; headRefOid?: string; headRefName?: string }): PrHealth {
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open';
  return {
    state,
    ...(pr.mergeable === 'CONFLICTING' ? { conflict: { base: pr.baseRefName || 'its base branch' } } : {}),
    ...(pr.headRefOid ? { head: pr.headRefOid } : {}),
    ...(pr.headRefName ? { headRef: pr.headRefName } : {}),
  };
}

/**
 * A pull request's health through gh (Pull requests: read only; no checks, no Actions). `mergeable` is UNKNOWN for a
 * moment after a push while GitHub works it out: that reads as no conflict, and the next read decides.
 */
export async function ghPrHealth(ref: string, run: Runner = runProc): Promise<PrHealth> {
  const m = CI_REF.exec(ref);
  if (!m) throw new Error(`"${ref}" is not a pull request (owner/repo#123)`);
  const r = await run('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'state,mergeable,baseRefName,headRefOid,headRefName'], { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
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
export async function ghChecks(ref: string, run: Runner = runProc): Promise<CiState> {
  const m = CI_REF.exec(ref);
  if (!m) throw new Error(`"${ref}" is not a pull request (owner/repo#123)`);
  const opts = { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } };
  const r = await run('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'state,statusCheckRollup'], opts);
  if (r.code === 0) return checksState(JSON.parse(r.stdout) as { state?: string; statusCheckRollup?: GhCheck[] }, ref);
  const p = await run('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'state,headRefOid'], opts);
  if (p.code !== 0) throw new Error(`gh pr view ${ref}: ${ghSaid(p)}`);
  const pr = JSON.parse(p.stdout) as { state?: string; headRefOid?: string };
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return checksState(pr, ref);
  if (!pr.headRefOid) throw new Error(`gh pr view ${ref} gave no head commit; its checks: ${ghSaid(r)}`);
  const a = await run('gh', ['api', `repos/${m[1]}/actions/runs?head_sha=${pr.headRefOid}&per_page=100`], opts);
  if (a.code !== 0) {
    // w889: the last reading, the PR's merge state (Pull requests: read), which tells a green finish from a running CI.
    const ms = await run('gh', ['api', `repos/${m[1]}/pulls/${m[2]}`, '--jq', '{mergeable_state: .mergeable_state, head: .head.sha}'], opts);
    const said = `its checks: ${ghSaid(r)}; its Actions runs: ${ghSaid(a)}`;
    if (ms.code !== 0) throw new Error(`${said}; its merge state: ${ghSaid(ms)}`);
    const green = mergeStateCi(JSON.parse(ms.stdout) as MergeState, ref);
    if (green) return green;
    throw new Error(`${said}; its merge state: ${(JSON.parse(ms.stdout) as MergeState).mergeable_state ?? 'unknown'} (pending or failed checks cannot be told apart from it)`);
  }
  if (!rollupRefusedLogged) {
    rollupRefusedLogged = true;
    console.warn(`blocker watch: gh cannot read pull requests' checks (${ghSaid(r)}); CI blocks read their GitHub Actions runs instead`);
  }
  return runsState(JSON.parse(a.stdout) as { workflow_runs?: GhRun[] }, ref);
}
