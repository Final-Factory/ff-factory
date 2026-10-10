// Whether the portal can read CI on the game repo's pull requests (w889). The blocker watch's `ci:` gates depend on it,
// and for most of 2026-10-10 every read was refused in silence: each blocked request waited the full CI_UNREADABLE_MS
// before its worker was sent to look itself. This probes the credential the watch uses for work with no request behind
// it (the portal's own gh login, or the system payer's vault token where machines.githubFromVault has "portal" on), at
// start and every half hour, and says loudly what it cannot read: a system_status line, a dashboard banner for everyone,
// and a [host] notice to the dispatcher when it turns bad and when it recovers. Never a token: only what GitHub answered.
import type { RunOptions, RunResult } from './proc.ts';

/** What the credential reads, best first: the checks themselves, the Actions runs (w829), only the merge state (w889), nothing. */
export type CiReadLevel = 'checks' | 'actions' | 'merge-state' | 'none';

export interface CiReadHealth {
  level: CiReadLevel;
  repo: string;
  /** The pull request it was measured on. */
  pr?: number;
  at: string;
  /** What GitHub said to the reads that failed, on one line each. */
  why?: string;
}

type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const CI_READ_EVERY_MS = 30 * 60_000;

/** "owner/name" of a GitHub URL (https or ssh), or undefined. */
export function repoSlug(url: string | undefined): string | undefined {
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '')?.[1];
}

const said = (r: RunResult) => (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n')[0].slice(0, 160);

/** One measurement on the newest pull request of `repo`, read the way the blocker watch reads CI (ghChecks). */
export async function probeCiRead(repo: string, run: Runner, now = () => new Date()): Promise<CiReadHealth> {
  const opts = { timeoutMs: 30_000 };
  const at = () => now().toISOString();
  const list = await run('gh', ['pr', 'list', '-R', repo, '--state', 'all', '--limit', '1', '--json', 'number,headRefOid'], opts);
  if (list.code !== 0) return { level: 'none', repo, at: at(), why: `pull requests: ${said(list)}` };
  const pr = (JSON.parse(list.stdout || '[]') as { number?: number; headRefOid?: string }[])[0];
  if (!pr?.number || !pr.headRefOid) return { level: 'none', repo, at: at(), why: 'no pull request to measure on' };
  const rollup = await run('gh', ['pr', 'view', String(pr.number), '-R', repo, '--json', 'statusCheckRollup'], opts);
  if (rollup.code === 0) return { level: 'checks', repo, pr: pr.number, at: at() };
  const runs = await run('gh', ['api', `repos/${repo}/actions/runs?head_sha=${pr.headRefOid}&per_page=1`], opts);
  if (runs.code === 0) return { level: 'actions', repo, pr: pr.number, at: at(), why: `checks: ${said(rollup)}` };
  const ms = await run('gh', ['api', `repos/${repo}/pulls/${pr.number}`, '--jq', '.mergeable_state'], opts);
  const why = `checks: ${said(rollup)}; Actions runs: ${said(runs)}`;
  if (ms.code === 0) return { level: 'merge-state', repo, pr: pr.number, at: at(), why };
  return { level: 'none', repo, pr: pr.number, at: at(), why: `${why}; merge state: ${said(ms)}` };
}

/** Whether a level lets a CI wait end the moment CI does, green or red. */
export const ciReadOk = (level: CiReadLevel) => level === 'checks' || level === 'actions';

/** The fix, in one line (docs/vault.md section 13.2): what the credential needs on GitHub. */
export const CI_READ_FIX = 'give the portal\'s GitHub token (D7, fffctl gh-login) "Actions: Read-only" on Final-Factory/FinalFactory (edit the fine-grained token on github.com; its value stays), or install a person\'s vault GitHub token with Actions read and set machines.githubFromVault true machine "portal" (docs/vault.md section 13)';

/** The system_status line. */
export function ciReadLine(h: CiReadHealth | undefined): string {
  if (!h) return 'GitHub CI reads (w889): not measured yet (the first probe runs a minute after start)';
  const where = `${h.repo}${h.pr ? ` (measured on #${h.pr}, ${h.at.slice(11, 16)}Z)` : ''}`;
  if (h.level === 'checks') return `GitHub CI reads (w889): OK, the portal reads pull requests' checks on ${where}`;
  if (h.level === 'actions') return `GitHub CI reads (w889): OK, the portal reads GitHub Actions runs on ${where} (no fine-grained token can read check runs)`;
  if (h.level === 'merge-state') return `WARNING: GitHub CI reads (w889): the portal can read neither checks nor Actions runs on ${where}, only the merge state: a CI wait that ends green clears within minutes, a red one only after 15 minutes. ${h.why}. Fix: ${CI_READ_FIX}`;
  return `WARNING: GitHub CI reads (w889): the portal cannot read CI on ${where} at all: every CI wait sits 15 minutes before its worker looks itself. ${h.why ?? ''}. Fix: ${CI_READ_FIX}`;
}

/** The dashboard banner's text, or undefined when CI reads are fine (or not measured yet). */
export function ciReadBanner(h: CiReadHealth | undefined): string | undefined {
  if (!h || ciReadOk(h.level)) return undefined;
  return `${h.level === 'merge-state' ? 'Only green CI is seen at once; red CI waits 15 minutes' : 'Every CI wait sits 15 minutes'} on ${h.repo}. Fix: ${CI_READ_FIX}.`;
}

export interface CiReadWatchDeps {
  /** The game repo, "owner/name". */
  repo: () => string | undefined;
  /** The gh runner the blocker watch uses for work no request is behind (githubTokens.ts ghRunner). */
  runner: () => Runner;
  /** A loud notice: the dispatcher's [host] message and the host notification. */
  report: (title: string, body: string) => void;
  now?: () => Date;
}

export class CiReadWatch {
  private readonly d: CiReadWatchDeps;
  private timer?: NodeJS.Timeout;
  health?: CiReadHealth;

  constructor(d: CiReadWatchDeps) {
    this.d = d;
  }

  start(firstAfterMs = 60_000) {
    setTimeout(() => void this.check(), firstAfterMs).unref?.();
    this.timer = setInterval(() => void this.check(), CI_READ_EVERY_MS);
    this.timer.unref?.();
    return this;
  }

  close() {
    clearInterval(this.timer);
  }

  /** Measure now; report when it turns bad (or worse), and when it is fine again. */
  async check(): Promise<CiReadHealth | undefined> {
    const repo = this.d.repo();
    if (!repo) return undefined;
    let h: CiReadHealth;
    try {
      h = await probeCiRead(repo, this.d.runner(), this.d.now);
    } catch (e) {
      h = { level: 'none', repo, at: (this.d.now?.() ?? new Date()).toISOString(), why: (e as Error).message.slice(0, 200) };
    }
    const before = this.health?.level;
    this.health = h;
    if (h.level !== before) {
      if (!ciReadOk(h.level)) this.d.report('FF Factory cannot read CI on pull requests', ciReadLine(h).replace(/^WARNING: /, ''));
      else if (before && !ciReadOk(before)) this.d.report('FF Factory reads CI on pull requests again', ciReadLine(h));
    }
    return h;
  }
}
