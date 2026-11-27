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
}

/** The daemon's check: says what it would refuse (warn-only), and the commit figure for the RAM wait messages. */
export class CommitCheck {
  private readonly d: CommitCheckDeps;
  private lastSaid = new Map<string, number>();

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
    if (!c) return undefined;
    const jobs = this.d.ciJobs();
    const v = commitVerdict(c, { editors, ciJobs: jobs });
    const line = `${commitWords(c)}: ${v.roomGB.toFixed(1)} GB of room, under the ${v.wantGB.toFixed(0)} GB ${what} wants (${editors} editor${editors === 1 ? '' : 's'} x ${EDITOR_COMMIT_GB} GB, ${COMMIT_RESERVE_GB} GB reserve, ${jobsWords(jobs)} x ${CI_JOB_COMMIT_GB} GB)`;
    if (!v.short) {
      this.d.log(`commit check: ${what} admitted, ${commitWords(c)} (${v.roomGB.toFixed(1)} GB of room, ${v.wantGB.toFixed(0)} GB wanted, ${jobsWords(jobs)})`);
      return undefined;
    }
    // One line a minute per kind of start: an editor start retried in a loop says it once.
    const key = what.replace(/\s*".*$/, '');
    const at = this.lastSaid.get(key) ?? -Infinity;
    if (this.now() - at >= 60_000) {
      this.lastSaid.set(key, this.now());
      this.d.log(`commit check (warn-only, nothing refused): would refuse ${what}: ${line}`);
    }
    return line;
  }
}
