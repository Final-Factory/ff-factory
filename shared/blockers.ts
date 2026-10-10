// What a Blocked request waits on, and when that clears (w643, asked by Lothsahn: "make sure you consistently apply all
// 3 states in all cases"). Waiting on input is a person, Queued is capacity only, and Blocked is a thing: another
// request finishing or reporting, a deploy, a machine, a usage limit, a lock, a time, or CI. Pure: the blocker watch
// (server/blockerWatch.ts) reads the verdicts and unblocks, stalls or asks; list_work, read_work and the Dispatcher page
// name the blocker (docs/orchestrators.md, "Waiting, Queued, Blocked").
import type { WorkBlocker, WorkBlockerKind, WorkItem } from './types.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * How long a blocker may stay open before the request counts as stuck and the cleanup stalls it, by kind. Judgments
 * (w643): a CI run takes minutes to an hour, so 6 hours is a hung run; a lock held a day is a run that never ended; a
 * machine away three days is down, not asleep; a weekly usage limit resets within 7 days; a deploy is a person's call,
 * and a week without one is worth their look. A request blocker has none: it follows that request, which the cleanup
 * stalls by itself when nothing works on it. A time blocker clears at its time. A pull request (w754) can wait for review
 * for days; a week open is worth a person's look.
 */
export const BLOCKER_STUCK_MS: Record<WorkBlockerKind, number | undefined> = {
  request: undefined,
  deploy: 7 * DAY,
  machine: 3 * DAY,
  usage: 8 * DAY,
  lock: DAY,
  time: undefined,
  ci: 6 * HOUR,
  pr: 7 * DAY,
};

/**
 * How long a CI blocker may go without FF Factory being able to read the checks before it gives up and lets the worker
 * look for itself (w829: the portal's fine-grained GitHub token could not read statusCheckRollup, every read failed in
 * silence, and w814, w818 and w808 sat Blocked for hours after their CI finished). Several failed reads in a row.
 */
export const CI_UNREADABLE_MS = 15 * 60_000;

/**
 * How long a pull request's head commit may have no CI run before a ci gate stops waiting for it (w907). Measured on
 * ff-factory PR #283 (2026-10-10): CI started 18:30:39Z for a push made seconds before, so a run normally exists within a
 * minute; ten minutes is far past any queueing and short against the hour w890 sat on a head that never got one (its push
 * had silently failed, the PR conflicted with main, and GitHub runs no CI on a conflicted PR).
 */
export const CI_NO_RUN_MS = 10 * 60_000;

/** What a pull request says about its own head and mergeability (w907), read with the Pull requests permission only. */
export interface PrHealth {
  state: 'open' | 'merged' | 'closed';
  /** GitHub's mergeability is CONFLICTING (REST: mergeable_state "dirty"): CI cannot run. The base branch it conflicts with. */
  conflict?: { base: string };
  /** The head commit, and its branch. */
  head?: string;
  headRef?: string;
  /** Since when (ms) this portal has seen this head commit (set by the blocker watch). */
  headSeenAt?: number;
}

/** "PR #283" from "owner/repo#283". */
export const prLabel = (ref: string | undefined) => `PR #${(ref ?? '').split('#').pop()}`;

/** The words a worker is resumed with when its pull request conflicts (w907); also what unblock reads to skip the "read the checks" hint. */
export const conflictText = (ref: string | undefined, base: string) => `${prLabel(ref)} conflicts with ${base} (CI can't run): merge ${base} in, resolve, push, and wait again`;

/** "16:29 UTC" or "10-08 16:29 UTC". */
const utc = (iso: string | undefined, now: number) => {
  if (!iso) return 'a time';
  const day = (t: number) => Math.floor(t / DAY);
  return day(Date.parse(iso)) === day(now) ? `${iso.slice(11, 16)} UTC` : `${iso.slice(5, 10)} ${iso.slice(11, 16)} UTC`;
};

/** What "Blocked on …" names: "w633 finishing", "a portal deploy", "lothdesktop coming back", "CI on PR #12". */
export function blockerName(b: Pick<WorkBlocker, 'kind' | 'ref' | 'on' | 'until' | 'holder'>, now: number = Date.now()): string {
  switch (b.kind) {
    case 'request':
      return `${b.ref} ${b.on === 'report' ? 'reporting' : 'finishing'}`;
    case 'deploy':
      return b.ref === 'machines' ? "the machines' update" : b.ref ? `${b.ref}'s update` : 'a portal deploy';
    case 'machine':
      return `${b.ref} coming back online`;
    case 'usage':
      return `${b.ref ?? 'a Claude account'}'s usage limit`;
    case 'lock':
      return `${b.ref ?? 'a lock'}${b.holder ? ` (held by ${b.holder})` : ''}`;
    case 'time':
      return utc(b.until, now);
    case 'ci':
      return `CI on ${b.ref}`;
    case 'pr':
      return `PR ${b.ref} merging`;
  }
}

/** Every gate of a request, first the primary `blocked` and then `alsoBlocked` (w754); empty when it has none. */
export function gatesOf(w: Pick<WorkItem, 'blocked' | 'alsoBlocked'>): WorkBlocker[] {
  return w.blocked ? [w.blocked, ...(w.alsoBlocked ?? [])] : [];
}

/** "w727 finishing and PR Final-Factory/FinalFactory#1291 merging": what a request with several gates waits on. */
export function gatesName(gates: readonly WorkBlocker[], now: number = Date.now()): string {
  const names = gates.map((g) => blockerName(g, now));
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Whether two gates are the same wait (the later one replaces the earlier when a request is blocked again, w754). */
export const sameGate = (a: Pick<WorkBlocker, 'kind' | 'ref' | 'holder'>, b: Pick<WorkBlocker, 'kind' | 'ref' | 'holder'>) =>
  a.kind === b.kind && (a.ref ?? '').toLowerCase() === (b.ref ?? '').toLowerCase() && (a.holder ?? '').toLowerCase() === (b.holder ?? '').toLowerCase();

/** The most gates one request may have. */
export const MAX_GATES = 6;

/** What each kind waits on and when it clears, for the tool's description and the docs. */
export const BLOCKER_KIND_HELP: Record<WorkBlockerKind, string> = {
  request: 'another request (ref: its id, e.g. "w633"): clears when it closes as done, or with on "report" at its next report',
  deploy: "a deploy (ref: a machine id for that machine's daemon update; none for the portal): clears when a different commit runs there",
  machine: 'a machine offline or asleep (ref: its id): clears when it is online',
  usage: "a Claude account's usage limit (ref: the account's email or label): clears when its meters are clear",
  lock: 'a shared lock such as the nightly lab.lock (ref: its name; holder: the request holding it, if one does; until: when to look again): clears when the holder closes or reports, the nightly lab next reports, or at until',
  time: 'a time (until: ISO): clears when it passes',
  ci: 'CI or checks on a pull request (ref: "owner/repo#123"): clears when no check is still running, or the PR merged or closed',
  pr: 'a pull request MERGING (ref: "owner/repo#123"): clears when it merges; one closed without merging asks the requester. Use it for "wait for #1291 to merge"; ci clears when the checks finish, merged or not',
};

export interface BlockerFacts {
  now: number;
  /** A request by id. */
  work: (id: string) => WorkItem | undefined;
  /** Whether a worker on `w` finished a turn (reported) after `since` (ms). */
  reportedSince?: (w: WorkItem, since: number) => boolean;
  /** The commit the portal runs now. */
  portalSha?: string;
  /** The commit a machine's daemon runs now, or undefined when unknown. */
  daemonSha?: (machineId: string) => string | undefined;
  /** Whether a machine is online; undefined for a machine this portal does not have. */
  online?: (machineId: string) => boolean | undefined;
  /** Whether a Claude account's meters are clear; undefined when unknown. */
  usageClear?: (account: string) => boolean | undefined;
  /** When the nightly lab last posted its results (ms), if ever. */
  nightlyAt?: number;
  /** A pull request's checks: done (none still running, or it merged or closed) and a line saying how. */
  ci?: (ref: string) => { done: boolean; text: string; none?: boolean } | undefined;
  /** w907: a pull request's head and mergeability; undefined when it cannot be read. */
  prHealth?: (ref: string) => PrHealth | undefined;
  /** w829: since when (ms) a pull request's checks could not be read, and why; undefined while they can be. */
  ciUnreadable?: (ref: string) => { since: number; why: string } | undefined;
  /** A pull request's state (w754, the pr blocker): open, merged, or closed without merging; undefined when unknown. */
  pr?: (ref: string) => { state: 'open' | 'merged' | 'closed'; text: string } | undefined;
}

/**
 * open: still waiting, and its blocker is still progressing. clear: it may go (the dispatcher is told to start it).
 * stuck: the blocker stalled or did not clear in time (the request is stalled with this reason). decide: the blocker
 * closed without delivering, so a person must say whether it is still wanted (the request waits on its requester).
 */
export type BlockerVerdict = { state: 'open' | 'clear' | 'stuck' | 'decide'; why: string };

const STATUS_DONE_WORDS: Partial<Record<WorkItem['status'], string>> = { rejected: 'declined', cancelled: 'cancelled' };

/** The request a merged one continues as (merges are followed a few steps). */
function follow(id: string, f: BlockerFacts): WorkItem | undefined {
  let t = f.work(id);
  for (let i = 0; i < 5 && t?.status === 'merged' && t.mergedInto; i++) t = f.work(t.mergedInto);
  return t;
}

const firstLine = (s: string | undefined) => (s ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? '';

/** Whether a blocker has cleared, is still open, or is stuck, and why. */
export function blockerVerdict(b: WorkBlocker, f: BlockerFacts): BlockerVerdict {
  const at = Date.parse(b.at) || f.now;
  const age = f.now - at;
  const since = (h: number) => (h < 2 * DAY ? `${Math.round(h / HOUR)} h` : `${Math.round(h / DAY)} days`);
  const late = (open: string): BlockerVerdict => {
    const max = BLOCKER_STUCK_MS[b.kind];
    return max !== undefined && age >= max ? { state: 'stuck', why: `${open} for ${since(age)} (a ${b.kind} blocker is looked at after ${since(max)})` } : { state: 'open', why: open };
  };
  switch (b.kind) {
    case 'request': {
      const t = b.ref ? follow(b.ref, f) : undefined;
      if (!t) return { state: 'stuck', why: `${b.ref ?? 'the request it waits on'} is not in the ledger` };
      const name = t.id === b.ref ? t.id : `${b.ref} (merged into ${t.id})`;
      if (t.status === 'done') return { state: 'clear', why: `${name} closed as done${t.outcome ? `: ${firstLine(t.outcome)}` : ''}` };
      if (STATUS_DONE_WORDS[t.status]) return { state: 'decide', why: `${name} was ${STATUS_DONE_WORDS[t.status]} without delivering ${b.what}${t.outcome ? ` (${firstLine(t.outcome)})` : ''}` };
      if (t.status === 'stalled') return { state: 'stuck', why: `${name}, which it waits on, stalled${t.stalled ? `: ${firstLine(t.stalled.reason)}` : ''}` };
      if (b.on === 'report' && f.reportedSince?.(t, at)) return { state: 'clear', why: `${name}'s worker reported${t.outcome ? `: ${firstLine(t.outcome)}` : ''}` };
      return { state: 'open', why: `${name} is ${t.status === 'blocked' ? 'itself blocked' : t.status}` };
    }
    case 'deploy': {
      const now = b.ref ? f.daemonSha?.(b.ref) : f.portalSha;
      const where = b.ref ? `${b.ref}'s daemon` : 'the portal';
      if (now && b.sha && now !== b.sha) return { state: 'clear', why: `${where} runs ${now.slice(0, 12)} now (${b.sha.slice(0, 12)} when it was blocked)` };
      return late(`${where} still runs ${(now ?? b.sha ?? 'an unknown commit').slice(0, 12)}`);
    }
    case 'machine': {
      const on = b.ref ? f.online?.(b.ref) : undefined;
      if (on === true) return { state: 'clear', why: `${b.ref} is online` };
      if (on === undefined && f.online) return { state: 'stuck', why: `${b.ref ?? 'its machine'} is not a machine of this portal` };
      return late(`${b.ref} is offline`);
    }
    case 'usage': {
      if (b.ref && f.usageClear?.(b.ref) === true) return { state: 'clear', why: `${b.ref}'s usage meters are clear` };
      return late(`${b.ref ?? 'the account'} is still at its limit`);
    }
    case 'lock': {
      const h = b.holder ? follow(b.holder, f) : undefined;
      if (h && !['new', 'question', 'queued', 'blocked', 'active'].includes(h.status)) return { state: 'clear', why: `${h.id}, which held ${b.ref ?? 'it'}, is ${h.status}` };
      if (h && f.reportedSince?.(h, at)) return { state: 'clear', why: `${h.id}, which held ${b.ref ?? 'it'}, reported` };
      if (f.nightlyAt && f.nightlyAt > at) return { state: 'clear', why: `the nightly lab reported since (${new Date(f.nightlyAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)` };
      if (b.until && f.now >= Date.parse(b.until)) return { state: 'clear', why: `time to look again at ${b.ref ?? 'the lock'} (${utc(b.until, f.now)})` };
      return late(`${b.ref ?? 'the lock'} is held${h ? ` by ${h.id}` : ''}`);
    }
    case 'time': {
      const t = Date.parse(b.until ?? '');
      if (!Number.isFinite(t) || f.now >= t) return { state: 'clear', why: `it is past ${utc(b.until, f.now)}` };
      return { state: 'open', why: `until ${utc(b.until, f.now)}` };
    }
    case 'ci': {
      const c = b.ref ? f.ci?.(b.ref) : undefined;
      if (c?.done) return { state: 'clear', why: c.text };
      // w829: checks FF Factory cannot read do not hold the request in silence: after CI_UNREADABLE_MS its worker looks.
      // The clock starts at the later of the first failed read and this block, so a request blocked again on the same
      // unreadable CI waits its own CI_UNREADABLE_MS (no clear-and-block-again loop every minute).
      // w907: a pull request that conflicts with its base gets no CI (w890's #283 waited an hour for checks that could
      // not start), nor one whose head has had no run for CI_NO_RUN_MS (a push that never reached it): the worker looks.
      const h = b.ref ? f.prHealth?.(b.ref) : undefined;
      if (h?.state === 'open' && h.conflict && (!c || c.none)) return { state: 'clear', why: conflictText(b.ref, h.conflict.base) };
      if (h?.state === 'open' && c?.none && h.headSeenAt !== undefined && f.now - h.headSeenAt >= CI_NO_RUN_MS) {
        return { state: 'clear', why: `no CI run exists for ${prLabel(b.ref)}'s head ${(h.head ?? '').slice(0, 7)} ${Math.round((f.now - h.headSeenAt) / 60_000)} min after it was pushed (${c.text}): check that your push reached it (gh pr view ${b.ref?.split('#')[1]} --json headRefOid), push, and wait again` };
      }
      const u = !c && b.ref ? f.ciUnreadable?.(b.ref) : undefined;
      const unreadableFor = u ? f.now - Math.max(u.since, at) : 0;
      if (u && unreadableFor >= CI_UNREADABLE_MS) return { state: 'clear', why: `FF Factory could not read CI on ${b.ref} for ${Math.round(unreadableFor / 60_000)} min (${u.why}), so its worker checks CI itself` };
      return late(c?.text ?? `CI on ${b.ref} is running`);
    }
    case 'pr': {
      const p = b.ref ? f.pr?.(b.ref) : undefined;
      if (p?.state === 'merged') return { state: 'clear', why: p.text };
      if (p?.state === 'closed') return { state: 'decide', why: `${p.text} without delivering ${b.what}` };
      // w907: a PR its own worker waits on cannot merge while it conflicts: the worker is woken to merge the base in.
      const h = b.ref && b.by.startsWith('worker ') ? f.prHealth?.(b.ref) : undefined;
      if (h?.state === 'open' && h.conflict) return { state: 'clear', why: conflictText(b.ref, h.conflict.base) };
      return late(p?.text ?? `PR ${b.ref} is open`);
    }
  }
}

/** A pull request as a ci or pr blocker names it: "owner/repo#123". */
export const CI_REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/** "owner/repo#123" from that, or from a github.com pull request link; undefined for anything else (a bare "#123" has no repo). */
export function prRefOf(text: string): string | undefined {
  const t = text.trim();
  if (CI_REF.test(t)) return t;
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(t);
  return m ? `${m[1]}#${m[2]}` : undefined;
}

/** Why a blocker cannot be set as given, or undefined (decide_work block). */
export function blockerProblem(b: Pick<WorkBlocker, 'kind' | 'ref' | 'until' | 'on' | 'holder' | 'what'>, self: string, f: Pick<BlockerFacts, 'now' | 'work' | 'online'>): string | undefined {
  if (!b.what.trim()) return 'say what it waits for (blocker.what), e.g. "w633\'s timing table"';
  const until = b.until ? Date.parse(b.until) : undefined;
  if (b.until && !Number.isFinite(until)) return `blocker.until "${b.until}" is not a time (ISO, e.g. 2026-10-08T06:00:00Z)`;
  const req = (id: string | undefined, field: string) => {
    if (!id) return `blocker.${field}: the request id, e.g. "w633"`;
    if (id.toLowerCase() === self.toLowerCase()) return 'a request cannot be blocked on itself';
    const t = follow(id, f as BlockerFacts);
    if (!t) return `no request "${id}"`;
    if (t.status === 'done' || t.status === 'rejected' || t.status === 'cancelled') return `${id} is ${t.status} already: start this one, or say what else it waits for`;
    if (gatesOf(t).some((g) => g.kind === 'request' && g.ref?.toLowerCase() === self.toLowerCase())) return `${id} is itself blocked on ${self}: they would wait on each other`;
    return undefined;
  };
  switch (b.kind) {
    case 'request':
      return req(b.ref, 'ref');
    case 'lock':
      return b.holder ? req(b.holder, 'holder') : !b.ref ? 'blocker.ref: the lock, e.g. "lab.lock"' : undefined;
    case 'machine':
      if (!b.ref) return 'blocker.ref: the machine id';
      if (f.online?.(b.ref) === undefined) return `no machine "${b.ref}"`;
      if (f.online(b.ref)) return `${b.ref} is online: start it there, or say what else it waits for`;
      return undefined;
    case 'deploy':
      if (b.ref && f.online?.(b.ref) === undefined) return `no machine "${b.ref}" (leave ref out for a portal deploy)`;
      return undefined;
    case 'usage':
      return b.ref ? undefined : "blocker.ref: the Claude account (its email or label)";
    case 'time':
      if (until === undefined) return 'blocker.until: when it may go (ISO)';
      return until! <= f.now ? `${b.until} has passed: start it now` : undefined;
    case 'ci':
    case 'pr':
      return b.ref && CI_REF.test(b.ref) ? undefined : 'blocker.ref: the pull request, "owner/repo#123"';
  }
}
