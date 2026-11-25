/**
 * steam_upload (w5551, docs/steam-upload.md): the urgent release lane's Steam upload, run by the daemon, never by a worker.
 * No worker holds the build account's password (FFSTEAM_PASSWORD, FFSTEAM_GUARD_SECRET are never in an agent's
 * environment, vault.ts DAEMON_ONLY_ENV) and no worker reads steamcmd's folder (`<root>/steam`, its config and cached
 * login: the worker fence's read-deny). The worker that builds an urgent release calls the tool; the portal checks here
 * that the build is its own request's and that the Steam branch is the one the release names, then sends the daemon the
 * credential with the job, and the daemon copies the players into its own folder, checks them again (ffbox
 * ffrelease-check.py) and runs ffbox ffsteam.py.
 *
 * This file holds the portal's decisions (pure, tested in steamUpload.test.ts) and the jobs it follows.
 */

export type SteamApp = 'main' | 'demo';
export const STEAM_APPS: readonly SteamApp[] = ['main', 'demo'];
export const STEAM_PLATFORMS = ['windows', 'mac', 'linux'] as const;
export type SteamPlatform = (typeof STEAM_PLATFORMS)[number];
/** The branches a release is cut from (the game repo's urgent_release.py BRANCHES). */
export const RELEASE_BRANCHES = ['master', 'pre-1.0'] as const;
export type ReleaseBranch = (typeof RELEASE_BRANCHES)[number];
export const VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The Steam branches an upload of `app` from `branch` sets live: ffbox release_lane.SETLIVE, `{("master", "main"):
 * ("development",)}`, and nothing for pre-1.0 (UPLOAD_ONLY_BRANCHES). Default and every other branch are set by a person on
 * the partner site, never by an agent (Release-Lanes.md, "Development only").
 */
export function liveBranchesFor(branch: ReleaseBranch, app: SteamApp): string[] {
  return branch === 'master' && app === 'main' ? ['development'] : [];
}

/** `cicd/release-lane.json` in the bump commit (trigger-ci-release.sh --urgent): the urgent lane's claim. */
export interface ReleaseClaim {
  lane?: unknown;
  version?: unknown;
  machine?: unknown;
  request?: unknown;
}

export interface UploadAsk {
  version: string;
  app: SteamApp;
  /** The commit built: the bump on master or pre-1.0, which carries the claim. */
  sha: string;
  /** Each platform's run folder (build-release.sh's worker folder: release.json, build.log, release/player). */
  runs: Partial<Record<SteamPlatform, string>>;
  /** The Steam branch to set live, if any. */
  live?: string;
  /** --preview: steamcmd builds the manifests and uploads nothing, sets nothing live. */
  preview: boolean;
}

/** What the portal found about the ask: the caller, its build plan, the claim at the commit, the branch holding it. */
export interface UploadFacts {
  machine: string;
  /** The caller's open requests. */
  requests: string[];
  /** The caller is the builder of a release build plan that has started on this machine. */
  building: boolean;
  /** The claim at `sha`, undefined when the commit has none (or it could not be read: `claimError`). */
  claim?: ReleaseClaim;
  claimError?: string;
  /** The release branch whose history holds `sha`, if any. */
  branch?: ReleaseBranch;
  /** This version's app was uploaded already (not a preview). */
  uploaded?: boolean;
}

/** Parse and shape-check the tool's arguments; a string is the refusal. */
export function parseAsk(a: Record<string, unknown>): UploadAsk | string {
  const version = String(a.version ?? '').trim();
  if (!VERSION_RE.test(version)) return `version must be four numbers (1.0.0.12), not ${JSON.stringify(a.version ?? '')}`;
  const app = String(a.app ?? 'main') as SteamApp;
  if (!STEAM_APPS.includes(app)) return `app is main or demo, not ${JSON.stringify(a.app)}`;
  const sha = String(a.sha ?? '').trim().toLowerCase();
  if (!SHA_RE.test(sha)) return 'sha must be the full 40-character commit the build was made from (the bump)';
  const raw = a.runs;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'runs is an object: { "windows": "<run folder>", "mac": "<run folder>", "linux"?: "<run folder>" }';
  const runs: Partial<Record<SteamPlatform, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(STEAM_PLATFORMS as readonly string[]).includes(k)) return `runs names windows, mac and linux only, not ${JSON.stringify(k)}`;
    if (typeof v !== 'string' || !v.trim()) return `runs.${k} must be a folder path`;
    runs[k as SteamPlatform] = v.trim();
  }
  if (!runs.windows || !runs.mac) return 'runs needs windows and mac (and linux where the app has a Linux depot): Steam gets every depot of a build at once';
  const live = a.live === undefined || a.live === null || a.live === '' ? undefined : String(a.live).trim();
  return { version, app, sha, runs, ...(live ? { live } : {}), preview: a.preview === true };
}

/**
 * Why the portal refuses the upload, or undefined to go on. A preview (manifests only, nothing uploaded, nothing set live)
 * needs only a branch nothing is set live on; an upload needs every check: it is the caller's own release build (a
 * started release build plan, and the claim in the bump names this version, this computer and one of the caller's open
 * requests), the commit is on master or pre-1.0, the live branch is the one that release names, and the app is not
 * uploaded for this version already.
 */
export function refuseUpload(ask: UploadAsk, f: UploadFacts): string | undefined {
  // The live branch first: a preview sets nothing live, an upload only what its release names.
  if (ask.preview) {
    if (ask.live) return `a preview sets nothing live: leave out live (${ask.live})`;
    return undefined;
  }
  if (!f.building) return `you are not building a release on ${f.machine}: steam_upload uploads only the build of a release build plan you started (build_plan with release: true, then start)`;
  if (f.claimError) return `could not read the release claim at ${ask.sha.slice(0, 10)}: ${f.claimError}`;
  const c = f.claim;
  if (!c) return `${ask.sha.slice(0, 10)} carries no cicd/release-lane.json: it is not an urgent-lane release, and FFBox uploads its own`;
  if (c.lane !== 'urgent') return `the claim at ${ask.sha.slice(0, 10)} is lane ${JSON.stringify(c.lane)}, not urgent`;
  if (c.version !== ask.version) return `the claim at ${ask.sha.slice(0, 10)} is for version ${JSON.stringify(c.version)}, not ${ask.version}: another release's build`;
  if (typeof c.machine !== 'string' || c.machine.toLowerCase() !== f.machine.toLowerCase()) return `the claim at ${ask.sha.slice(0, 10)} names ${JSON.stringify(c.machine)} to build ${ask.version}, not ${f.machine}`;
  const req = typeof c.request === 'string' ? c.request.toLowerCase() : '';
  if (!req || !f.requests.some((r) => r.toLowerCase() === req)) return `${ask.version} is ${JSON.stringify(c.request)}'s release, not one of your requests (${f.requests.join(', ') || 'none'}): steam_upload uploads only your own request's build`;
  if (!f.branch) return `${ask.sha.slice(0, 10)} is not on master or pre-1.0: only a merged bump is uploaded`;
  const allowed = liveBranchesFor(f.branch, ask.app);
  if (ask.live && !allowed.includes(ask.live)) {
    return allowed.length
      ? `a ${f.branch} ${ask.app} release sets ${allowed.join(', ')} live, not ${ask.live}: no other Steam branch is set by an agent`
      : `a ${f.branch} ${ask.app} release sets no Steam branch live, not ${ask.live}: a person sets the others on the partner site`;
  }
  if (f.uploaded) return `${ask.app} ${ask.version} is uploaded already: steam_upload uploads a version's app once`;
  return undefined;
}

// ------------------------------------------------------------------------------------------------ the jobs

export type JobState = 'running' | 'done' | 'failed';

export interface SteamJob {
  id: string;
  machine: string;
  key: string;
  action: 'check' | 'upload' | 'install';
  version?: string;
  app?: SteamApp;
  preview?: boolean;
  live?: string;
  sha?: string;
  request?: string;
  by: string;
  startedAt: number;
  state: JobState;
  phase?: string;
  heardAt: number;
  /** The daemon's last lines (redacted there and here). */
  said?: string;
  /** steam-upload.json's facts (build ids), or the check's answer. */
  result?: Record<string, unknown>;
  error?: string;
  /** Its daemon's link dropped while it ran (failed for now; a later word from the daemon still counts). */
  lost?: boolean;
  done: Promise<void>;
  settle: () => void;
}

/** One running job per computer: steamcmd allows one session per account, and the build account is one. */
export class SteamJobs {
  private readonly jobs = new Map<string, SteamJob>();
  private readonly lastCheck = new Map<string, number>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  static keyOf(machine: string, action: 'check' | 'upload' | 'install', version?: string, app?: string, preview?: boolean) {
    return action === 'check' || action === 'install' ? `${machine}:${action}` : `${machine}:${version}:${app}:${preview ? 'preview' : 'upload'}`;
  }

  get(key: string): SteamJob | undefined {
    return this.jobs.get(key);
  }

  byId(id: string): SteamJob | undefined {
    for (const j of this.jobs.values()) if (j.id === id) return j;
    return undefined;
  }

  /** The job running on this computer, if any. */
  runningOn(machine: string): SteamJob | undefined {
    for (const j of this.jobs.values()) if (j.machine === machine && j.state === 'running') return j;
    return undefined;
  }

  /**
   * What status with no job answers (w5694): the job running on this computer, else its latest of any action. A check that
   * ended a second before the ask is still the one the caller means (BEAST, 2026-11-25: "No Steam job" right after it ended).
   */
  latestOn(machine: string): SteamJob | undefined {
    let latest: SteamJob | undefined;
    for (const j of this.jobs.values()) {
      if (j.machine !== machine) continue;
      if (j.state === 'running') return j;
      if (!latest || j.startedAt >= latest.startedAt) latest = j;
    }
    return latest;
  }

  /** Whether a login check may run now: at most one per computer every CHECK_EVERY_MS, so a loop never locks the account. */
  checkWait(machine: string, guardCode: boolean): number {
    if (guardCode) return 0;
    const last = this.lastCheck.get(machine);
    return last === undefined ? 0 : Math.max(0, last + SteamJobs.CHECK_EVERY_MS - this.now());
  }

  start(j: Omit<SteamJob, 'startedAt' | 'state' | 'heardAt' | 'done' | 'settle'>): SteamJob {
    let settle!: () => void;
    const done = new Promise<void>((r) => (settle = r));
    const job: SteamJob = { ...j, startedAt: this.now(), heardAt: this.now(), state: 'running', done, settle };
    this.jobs.set(j.key, job);
    if (j.action === 'check') this.lastCheck.set(j.machine, this.now());
    return job;
  }

  /** The daemon's word on a job. */
  update(id: string, u: { state: JobState; phase?: string; said?: string; result?: Record<string, unknown>; error?: string }): SteamJob | undefined {
    const j = this.byId(id);
    // A job its link dropped is failed for the caller, and the daemon's later word (it ran on) still counts.
    if (!j || (j.state !== 'running' && !j.lost)) return j;
    j.lost = false;
    j.heardAt = this.now();
    j.state = u.state;
    if (u.phase) j.phase = u.phase;
    if (u.said !== undefined) j.said = u.said;
    if (u.result) j.result = u.result;
    if (u.error) j.error = u.error;
    if (u.state !== 'running') j.settle();
    return j;
  }

  /** A computer's daemon went away: its running jobs ended with it. */
  lost(machine: string, why: string) {
    for (const j of this.jobs.values()) {
      if (j.machine !== machine || j.state !== 'running') continue;
      this.update(j.id, { state: 'failed', error: `${why}: whether it finished is unknown. The daemon runs one Steam job at a time and refuses a version's app it uploaded already, so calling again is safe` });
      j.lost = true;
    }
  }

  static CHECK_EVERY_MS = 10 * 60_000;
}

const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** What the tool answers about a job. */
export function describeJob(j: SteamJob, now = Date.now()): string {
  const what = j.action === 'check' ? `Steam login check on ${j.machine}` : `${j.preview ? 'preview of ' : ''}${j.app} ${j.version} upload on ${j.machine}${j.live ? ` (sets ${j.live} live)` : ''}`;
  const lines = [`${what}: ${j.state}${j.phase ? ` (${j.phase})` : ''}, started ${ago(now - j.startedAt)} ago, last word from the daemon ${ago(now - j.heardAt)} ago.`];
  if (j.error) lines.push(`Error: ${j.error}`);
  if (j.result && Object.keys(j.result).length) lines.push(`Result: ${JSON.stringify(j.result)}`);
  if (j.said) lines.push(`Its last lines:\n${j.said}`);
  if (j.state === 'running') lines.push(`Ask again with the same arguments (or action "status") to follow it.`);
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------ what GitHub says

type Gh = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string | undefined> }) => Promise<{ code: number; stdout: string; stderr: string }>;
const GH_ENV = () => ({ ...process.env, GH_PROMPT_DISABLED: '1' });

/** The claim at `sha` in the game repo (cicd/release-lane.json), none when the commit has no such file. */
export async function readClaim(gh: Gh, repo: string, sha: string): Promise<{ claim?: ReleaseClaim; error?: string }> {
  const r = await gh('gh', ['api', `repos/${repo}/contents/cicd/release-lane.json?ref=${sha}`, '--jq', '.content'], { timeoutMs: 30_000, env: GH_ENV() });
  if (r.code !== 0) {
    if (/HTTP 404|Not Found/i.test(r.stderr + r.stdout)) return {};
    return { error: (r.stderr || r.stdout).trim().slice(-300) || `gh exited ${r.code}` };
  }
  try {
    const doc = JSON.parse(Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64').toString('utf8')) as unknown;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'cicd/release-lane.json is not a JSON object' };
    return { claim: doc as ReleaseClaim };
  } catch (e) {
    return { error: `cicd/release-lane.json does not parse: ${(e as Error).message}` };
  }
}

/** The release branch whose history holds `sha` (GitHub's compare: the branch is ahead of it or the same), if any. */
export async function branchOf(gh: Gh, repo: string, sha: string): Promise<ReleaseBranch | undefined> {
  for (const b of RELEASE_BRANCHES) {
    const r = await gh('gh', ['api', `repos/${repo}/compare/${sha}...${b}`, '--jq', '.status'], { timeoutMs: 30_000, env: GH_ENV() });
    if (r.code === 0 && /^(ahead|identical)$/.test(r.stdout.trim())) return b;
  }
  return undefined;
}
