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
import { blockerVerdict, CI_REF, gatesOf, type BlockerFacts } from '../shared/blockers.ts';
import type { SessionInfo, WorkItem } from '../shared/types.ts';

const EVERY_MS = 60_000;
/** A pull request's checks are read at most this often each (gh; GitHub's rate limit is 5000 calls an hour). */
const CI_EVERY_MS = 5 * 60_000;
const BUSY: ReadonlySet<SessionInfo['status']> = new Set(['running', 'starting', 'waiting_permission']);

export type CiState = { done: boolean; text: string };
/** A pull request's state (w754): open, merged, or closed without merging, and a line saying how. */
export type PrState = { state: 'open' | 'merged' | 'closed'; text: string };

export interface BlockerWatchDeps {
  store: Store;
  orchestrators: Pick<Orchestrators, 'unblock' | 'blockerStuck' | 'blockerDecide' | 'gatesCleared' | 'flagQueuedWithRoom'>;
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
  /** A pull request's checks ("owner/repo#123"); default gh. Throws (or answers undefined) when they cannot be read. */
  ci?: (ref: string) => Promise<CiState | undefined>;
  /** A pull request's state ("owner/repo#123"); default gh. */
  pr?: (ref: string) => Promise<PrState | undefined>;
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
  private readonly prSeen = new Map<string, { at: number; state?: PrState }>();
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
      for (const w of blocked) {
        for (const g of gatesOf(w)) {
          if (!g.ref) continue;
          if (g.kind === 'ci') ci.set(g.ref, await this.ciOf(g.ref));
          else if (g.kind === 'pr') pr.set(g.ref, await this.prOf(g.ref));
        }
      }
      const facts = this.facts(ci, pr);
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

  private facts(ci: ReadonlyMap<string, CiState | undefined>, pr: ReadonlyMap<string, PrState | undefined>): BlockerFacts {
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
    };
  }

  /** A pull request's state, read at most every CI_EVERY_MS (w754). */
  private async prOf(ref: string): Promise<PrState | undefined> {
    const seen = this.prSeen.get(ref);
    if (seen && this.now() - seen.at < CI_EVERY_MS) return seen.state;
    const state = await (this.d.pr ?? ghPr)(ref).catch(() => undefined);
    this.prSeen.set(ref, { at: this.now(), state });
    return state;
  }

  /**
   * A pull request's checks, read at most every CI_EVERY_MS. A read that fails is remembered (ciUnreadable) and logged, the
   * first time and every 30 minutes after (w829: it failed in silence for hours), and so is its recovery.
   */
  private async ciOf(ref: string): Promise<CiState | undefined> {
    const seen = this.ciSeen.get(ref);
    const now = this.now();
    if (seen && now - seen.at < CI_EVERY_MS) return seen.state;
    let state: CiState | undefined;
    let why = 'no answer';
    try {
      state = await (this.d.ci ?? ghChecks)(ref);
    } catch (e) {
      why = clipLine((e as Error).message, 300);
    }
    this.ciSeen.set(ref, { at: now, state });
    const was = this.ciFailing.get(ref);
    if (state) {
      if (was) console.log(`blocker watch: CI on ${ref} reads again after ${Math.round((now - was.since) / 60_000)} min: ${state.text}`);
      this.ciFailing.delete(ref);
    } else if (!was || now - was.logged >= 30 * 60_000) {
      console.warn(`blocker watch: cannot read CI on ${ref}${was ? ` (for ${Math.round((now - was.since) / 60_000)} min)` : ''}: ${why}`);
      this.ciFailing.set(ref, { since: was?.since ?? now, why, logged: now });
    } else this.ciFailing.set(ref, { ...was, why });
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
  if (!checks.length) return { done: false, text: `${ref} has no checks yet` };
  if (running.length) return { done: false, text: `${running.length} of ${checks.length} checks on ${ref} still running` };
  const failed = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes((c.conclusion ?? c.state ?? '').toUpperCase()));
  return { done: true, text: failed.length ? `CI on ${ref} finished: ${failed.length} of ${checks.length} checks failed (${failed.slice(0, 3).map((c) => c.name ?? c.context).join(', ')})` : `CI on ${ref} finished: all ${checks.length} checks passed or skipped` };
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
  if (!runs.length) return { done: false, text: `${ref} has no workflow runs yet` };
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
export function prState(pr: { state?: string }, ref: string): PrState {
  if (pr.state === 'MERGED') return { state: 'merged', text: `${ref} merged` };
  if (pr.state === 'CLOSED') return { state: 'closed', text: `${ref} was closed without merging` };
  return { state: 'open', text: `${ref} is still open` };
}

async function ghPr(ref: string): Promise<PrState | undefined> {
  const m = CI_REF.exec(ref);
  if (!m) return undefined;
  const r = await runProc('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'state'], { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (r.code !== 0) return undefined;
  return prState(JSON.parse(r.stdout) as { state?: string }, ref);
}

type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

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
  const said = (r: RunResult) => clipLine(r.stderr || r.stdout || `exit ${r.code}`, 200);
  const r = await run('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'state,statusCheckRollup'], opts);
  if (r.code === 0) return checksState(JSON.parse(r.stdout) as { state?: string; statusCheckRollup?: GhCheck[] }, ref);
  const p = await run('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'state,headRefOid'], opts);
  if (p.code !== 0) throw new Error(`gh pr view ${ref}: ${said(p)}`);
  const pr = JSON.parse(p.stdout) as { state?: string; headRefOid?: string };
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return checksState(pr, ref);
  if (!pr.headRefOid) throw new Error(`gh pr view ${ref} gave no head commit; its checks: ${said(r)}`);
  const a = await run('gh', ['api', `repos/${m[1]}/actions/runs?head_sha=${pr.headRefOid}&per_page=100`], opts);
  if (a.code !== 0) throw new Error(`its checks: ${said(r)}; its Actions runs: ${said(a)}`);
  if (!rollupRefusedLogged) {
    rollupRefusedLogged = true;
    console.warn(`blocker watch: gh cannot read pull requests' checks (${said(r)}); CI blocks read their GitHub Actions runs instead`);
  }
  return runsState(JSON.parse(a.stdout) as { workflow_runs?: GhRun[] }, ref);
}
