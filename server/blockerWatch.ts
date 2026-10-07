// The blocker watch (w643; docs/orchestrators.md, "Waiting, Queued, Blocked"). Every minute, and at once when a request
// is blocked, it looks at each Blocked request's blocker (shared/blockers.ts blockerVerdict) and:
//
// - clear: unblocks it, and the dispatcher is told to start it now (Orchestrators.unblock), with no person nudging it;
// - stuck (the blocker stalled, or did not clear in its time): stalls it with the reason (Orchestrators.blockerStuck);
// - decide (what it waited on closed without delivering): asks its requester (Orchestrators.blockerDecide);
// - open: leaves it, and the ledger cleanup leaves it too (stallCandidate never takes a blocked request).
//
// It also flags requests queued for capacity while a computer that could take them has room (flagQueuedWithRoom).
// A deploy blocker the ledger cleanup set itself (a merged request whose only step left is a deploy) is the cleanup's:
// it closes the request when the deploy runs the merge (server/ledgerSweep.ts), so this watch leaves it alone.
import type { Store } from './store.ts';
import type { Orchestrators } from './orchestrators.ts';
import { run as runProc } from './proc.ts';
import { blockerVerdict, CI_REF, type BlockerFacts } from '../shared/blockers.ts';
import type { SessionInfo, WorkItem } from '../shared/types.ts';

const EVERY_MS = 60_000;
/** A pull request's checks are read at most this often each (gh; GitHub's rate limit is 5000 calls an hour). */
const CI_EVERY_MS = 5 * 60_000;
const BUSY: ReadonlySet<SessionInfo['status']> = new Set(['running', 'starting', 'waiting_permission']);

export type CiState = { done: boolean; text: string };

export interface BlockerWatchDeps {
  store: Store;
  orchestrators: Pick<Orchestrators, 'unblock' | 'blockerStuck' | 'blockerDecide' | 'flagQueuedWithRoom'>;
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
  /** A pull request's checks ("owner/repo#123"); default gh. */
  ci?: (ref: string) => Promise<CiState | undefined>;
  /** The computers with room for one more worker now. */
  room?: () => string[];
  now?: () => number;
}

export class BlockerWatch {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private again = false;
  private readonly ciSeen = new Map<string, { at: number; state?: CiState }>();
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
      for (const w of blocked) if (w.blocked!.kind === 'ci' && w.blocked!.ref) ci.set(w.blocked!.ref, await this.ciOf(w.blocked!.ref));
      const facts = this.facts(ci);
      for (const w of blocked) {
        const live = this.d.store.work.get(w.id);
        if (!live || live.status !== 'blocked' || !live.blocked) continue;
        const v = blockerVerdict(live.blocked, facts);
        if (v.state === 'open') continue;
        if (v.state === 'clear') this.d.orchestrators.unblock(live.id, v.why);
        else if (v.state === 'stuck') this.d.orchestrators.blockerStuck(live.id, v.why);
        else this.d.orchestrators.blockerDecide(live.id, v.why);
        did.set(live.id, `${v.state}: ${v.why}`);
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

  private facts(ci: ReadonlyMap<string, CiState | undefined>): BlockerFacts {
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
    };
  }

  /** A pull request's checks, read at most every CI_EVERY_MS. */
  private async ciOf(ref: string): Promise<CiState | undefined> {
    const seen = this.ciSeen.get(ref);
    if (seen && this.now() - seen.at < CI_EVERY_MS) return seen.state;
    const state = await (this.d.ci ?? ghChecks)(ref).catch(() => undefined);
    this.ciSeen.set(ref, { at: this.now(), state });
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

async function ghChecks(ref: string): Promise<CiState | undefined> {
  const m = CI_REF.exec(ref);
  if (!m) return undefined;
  const r = await runProc('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'state,statusCheckRollup'], { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (r.code !== 0) return undefined;
  return checksState(JSON.parse(r.stdout) as { state?: string; statusCheckRollup?: GhCheck[] }, ref);
}
