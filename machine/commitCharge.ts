import type { HostStats } from '../shared/types.ts';

/**
 * The commit-charge check (w6411, after w6409): on Windows a new Unity editor or a unity-slot grant needs room in the
 * commit charge (RAM plus the page file), not only free RAM. On BEAST (64 GB RAM, a 64 GB page file: a 127.8 GB limit)
 * three editors and a unity-slot run started beside two ffu test jobs in five minutes, commit went from 57.6 GB to the
 * full 127.8 GB, the test binaries failed to allocate and the daemon could not list processes (0xC0000142).
 *
 * The room is the limit less what is committed; a start wants an editor's need per slot, a reserve, and a share per CI job
 * running on this machine's runners (their memory grows while they run). This step is warn-only (lothsahn's lockout
 * rule): the daemon logs what the check would refuse and refuses nothing. The pool setting commitCheck "off" (add_machine
 * commit_check, sent in the portal's welcome) turns it off with nobody at the machine. Refusing is a later change.
 */

export const GB = 1024 ** 3;
/** What one Unity editor commits, about (limits.minFreeRamGB's default: the RAM an editor needs; a guess, not measured). */
export const EDITOR_COMMIT_GB = 10;
/** Commit kept free besides the starts: the daemon, agents' shells and Windows itself need to allocate (a guess). */
export const COMMIT_RESERVE_GB = 4;
/** What one running CI job may still commit (an ffu test job; a guess from w6409, where two of them shared the room). */
export const CI_JOB_COMMIT_GB = 8;

export type CommitCheckMode = 'warn' | 'off';

export interface CommitNeed {
  /** Editors the start brings: 1 for an editor, a unity-slot grant's slot count. */
  editors: number;
  /** CI jobs running on this machine's runners now; undefined: not known (counted as none). */
  ciJobs?: number;
}

export interface CommitVerdict {
  roomGB: number;
  wantGB: number;
  short: boolean;
}

/** The room in the commit charge against what a start wants. */
export function commitVerdict(c: Pick<NonNullable<HostStats['commit']>, 'committedBytes' | 'limitBytes'>, n: CommitNeed): CommitVerdict {
  const roomGB = (c.limitBytes - c.committedBytes) / GB;
  const wantGB = n.editors * EDITOR_COMMIT_GB + COMMIT_RESERVE_GB + (n.ciJobs ?? 0) * CI_JOB_COMMIT_GB;
  return { roomGB, wantGB, short: roomGB < wantGB };
}

/** "commit 71.5 of 127.8 GB": the figure that goes beside RAM in a wait message. */
export function commitWords(c: Pick<NonNullable<HostStats['commit']>, 'committedBytes' | 'limitBytes'>): string {
  return `commit ${(c.committedBytes / GB).toFixed(1)} of ${(c.limitBytes / GB).toFixed(1)} GB`;
}

const jobsWords = (n?: number) => (n === undefined ? 'CI jobs unknown' : `${n} CI job${n === 1 ? '' : 's'} running`);

export interface CommitCheckDeps {
  /** The last commit charge read (server/system.ts commitNow); undefined off Windows or when the read failed: RAM only. */
  read(): HostStats['commit'];
  ciJobs(): number | undefined;
  mode(): CommitCheckMode;
  log(line: string): void;
  now?(): number;
  /** Whether this is a Windows machine, where a missing read is worth a line (default: process.platform). */
  windows?(): boolean;
}

/** The daemon's check: says what it would refuse (warn-only), and the commit figure for the RAM wait messages. */
export class CommitCheck {
  private readonly d: CommitCheckDeps;
  private lastSaid = new Map<string, number>();
  private saidNoRead = false;

  constructor(d: CommitCheckDeps) {
    this.d = d;
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** The commit figure for a RAM message, or undefined when it is not known. */
  words(): string | undefined {
    const c = this.d.read();
    return c ? commitWords(c) : undefined;
  }

  /**
   * A start of `what` is about to happen: log what the check would say. Warn-only, so it never refuses: it returns the
   * reason it would refuse with (for tests and the log), or undefined. A read that fails falls back to RAM only.
   */
  check(what: string, editors = 1): string | undefined {
    if (this.d.mode() === 'off') return undefined;
    const c = this.d.read();
    if (!c) {
      // w6414 nit A: a read that never works must not pass for "all fine" (no commit lines): said once until a read works
      if (!this.saidNoRead && (this.d.windows ?? (() => process.platform === 'win32'))()) {
        this.saidNoRead = true;
        this.d.log(`commit check: no commit charge read on this Windows machine (the read failed, or is over 2 minutes old); ${what} is checked on RAM only`);
      }
      return undefined;
    }
    this.saidNoRead = false;
    const jobs = this.d.ciJobs();
    const v = commitVerdict(c, { editors, ciJobs: jobs });
    const line = `${commitWords(c)}: ${v.roomGB.toFixed(1)} GB of room, under the ${v.wantGB.toFixed(0)} GB ${what} wants (${editors} editor${editors === 1 ? '' : 's'} x ${EDITOR_COMMIT_GB} GB, ${COMMIT_RESERVE_GB} GB reserve, ${jobsWords(jobs)} x ${CI_JOB_COMMIT_GB} GB)`;
    // One line a minute per kind of start and verdict (w6414 nit B: the admitted line too): a start retried in a loop says it once.
    const key = `${v.short ? 'short' : 'ok'} ${what.replace(/\s*".*$/, '')}`;
    const at = this.lastSaid.get(key) ?? -Infinity;
    const say = this.now() - at >= 60_000;
    if (say) this.lastSaid.set(key, this.now());
    if (!v.short) {
      if (say) this.d.log(`commit check: ${what} admitted, ${commitWords(c)} (${v.roomGB.toFixed(1)} GB of room, ${v.wantGB.toFixed(0)} GB wanted, ${jobsWords(jobs)})`);
      return undefined;
    }
    if (say) this.d.log(`commit check (warn-only, nothing refused): would refuse ${what}: ${line}`);
    return line;
  }
}

/**
 * Runs a step of the warn-only check so that a bug in it cannot change a start or a grant (w6414): an exception is logged
 * and the step counts as having said nothing.
 */
export function warnOnly<T>(what: string, f: () => T, log: (line: string) => void): T | undefined {
  try {
    return f();
  } catch (e) {
    try {
      log(`commit check: ${what} failed, ignored (warn-only, nothing changes): ${e instanceof Error ? e.message : String(e)}`);
    } catch {
      // the log itself failed: still nothing changes
    }
    return undefined;
  }
}

/**
 * The daemon's editor start gate with the commit check wired in (w6411; pulled out to be tested, w6414). `base` is the
 * gate as it was before the check (the host guard, then a person playing here), given the commit figure for its RAM
 * message. The gate returns what `base` returns, whatever the check says or throws: the check only logs.
 */
export function editorStartGate(d: { base: (commit: string | undefined) => string | undefined; check: Pick<CommitCheck, 'words' | 'check'>; log: (line: string) => void }): string | undefined {
  const commit = warnOnly('reading the commit figure', () => d.check.words(), d.log);
  const gate = d.base(commit);
  if (!gate) warnOnly('an editor start', () => void d.check.check('an editor start'), d.log);
  return gate;
}
