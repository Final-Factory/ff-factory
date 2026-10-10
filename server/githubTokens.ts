// Per-person GitHub tokens (w868, docs/vault.md section 13). lothsahn: "I'd like the right token to get used based on whether
// a request is Ben or lothsahn." The tokens are the vault's `github` entries (vault-<person>-github, synced from the FFBox
// host's people/<person>/github-token); this module decides where they are used and keeps their health:
//
// - the switch: config machines.githubFromVault, per machine like claudeFromVault, with the machine id "portal" for the
//   portal's own gh reads (PR states, CI checks). Off by default: until it is on, every caller uses the credential it had;
// - the portal's gh calls run with GH_TOKEN of the person the work is for (ghRunner), falling back to the portal's own
//   gh login when the person has no usable token or GitHub refuses theirs;
// - every token is probed (GET /user and a few reads per repository): its GitHub account, its expiry, which reads it
//   has; a 401 marks it bad and no run gets it until it is rotated. A value is never logged: names and last four only.
import type { Config } from './config.ts';
import type { Vault, VaultEntryMeta } from './vault.ts';
import { run as runProc, type RunOptions, type RunResult } from './proc.ts';
import type { GithubAccess, GithubTokenHealth, WorkItem } from '../shared/types.ts';

/** The machine id machines.githubFromVault uses for the portal's own GitHub reads. */
export const PORTAL_MACHINE = 'portal';

/** The repositories FF Factory touches, probed for each token (docs/vault.md section 13.2). */
export const GITHUB_REPOS = [
  'Final-Factory/FinalFactory',
  'Final-Factory/ff-factory',
  'Final-Factory/final-factory-agents',
  'Final-Factory/ffbox',
  'Final-Factory/ff-orchestrator-memory',
  'Final-Factory/finalfactory-agent-kit',
  'Final-Factory/ff-marketing',
];

/** How often every token is probed again; a new or rotated token (a fingerprint not seen yet) is probed at the next tick. */
export const PROBE_EVERY_MS = 6 * 60 * 60_000;

/**
 * Whether GitHub entries are used on a machine (config machines.githubFromVault, w868; default no): an entry naming the
 * machine, else "*", else the value itself. "portal" is the portal's own reads.
 */
export function githubFromVault(cfg: Pick<Config, 'machines'>, machineId: string): boolean {
  const u = cfg.machines?.githubFromVault;
  if (u === undefined) return false;
  if (typeof u === 'boolean') return u;
  return u[machineId.toLowerCase()] ?? u['*'] ?? false;
}

/**
 * Whose GitHub token a request's portal-side reads use: the person whose tokens its runs get (docs/vault.md section 10):
 * the configured person for intake, FFBox and nightly work nobody named, else its requester, else the system payer.
 */
export function githubPersonOf(tokenUser: string | undefined, w: Pick<WorkItem, 'requestedBy'> | undefined, payer: string | undefined): string | undefined {
  return tokenUser ?? w?.requestedBy?.userId ?? payer;
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** GitHub's "this token was refused" (401) and "this token lacks a permission" (403) as gh prints them. */
const REFUSED = /HTTP 401|Bad credentials/i;
const DENIED = /Resource not accessible by personal access token/i;
/** No fine-grained token can read check runs (GitHub has no Checks permission for them): an expected refusal, not the token's fault. */
const NO_CHECKS = /statusCheckRollup/;

/** "2027-10-01 00:00:00 UTC" (the header's form, sourced: composer/composer#11688) or ISO, as ISO; undefined otherwise. */
export function parseExpiry(h: string | null | undefined): string | undefined {
  if (!h) return undefined;
  const t = Date.parse(h.trim().replace(/ UTC$/, 'Z').replace(/^(\d{4}-\d\d-\d\d) /, '$1T'));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** What one probe read says about a permission: 200 read, 403 denied, 404 the repository is not selected, else error. */
const access = (status: number, notFound: GithubAccess = 'not-selected'): GithubAccess => (status === 200 ? 'read' : status === 403 ? 'denied' : status === 404 ? notFound : 'error');

export interface GithubTokensOptions {
  vault: () => Vault | undefined;
  cfg: Pick<Config, 'machines'>;
  fetch?: Fetch;
  /** gh, for the portal's calls; tests give their own. */
  run?: Runner;
  repos?: () => string[];
  /** The system payer (config systemPayer): whose token the portal's reads for no request use (docs/vault.md section 10). */
  payer?: () => string | undefined;
  now?: () => number;
  log?: (line: string) => void;
}

export class GithubTokens {
  private readonly o: GithubTokensOptions;
  /** By fingerprint: a rotated token is a new one. */
  private readonly health = new Map<string, GithubTokenHealth>();
  private timer?: NodeJS.Timeout;
  private probing = false;

  constructor(o: GithubTokensOptions) {
    this.o = o;
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  private at() {
    return new Date(this.now()).toISOString();
  }

  private of(e: Pick<VaultEntryMeta, 'fingerprint' | 'name' | 'owner' | 'last4'>): GithubTokenHealth {
    let h = this.health.get(e.fingerprint);
    if (!h) {
      h = { fingerprint: e.fingerprint, name: e.name, last4: e.last4, ...(e.owner ? { owner: e.owner } : {}) };
      this.health.set(e.fingerprint, h);
    }
    h.name = e.name;
    return h;
  }

  /** Why a token may not be used now (GitHub answered 401, or it is past its expiry), or undefined. */
  unusable(fingerprint: string): string | undefined {
    const h = this.health.get(fingerprint);
    if (!h) return undefined;
    if (h.bad) return h.bad;
    if (h.expiresAt && Date.parse(h.expiresAt) <= this.now()) return `expired ${h.expiresAt.slice(0, 10)}`;
    return undefined;
  }

  usable = (fingerprint: string) => !this.unusable(fingerprint);

  /** A token was used for `what` (handed to a worker, a portal read). */
  noteUse(e: Pick<VaultEntryMeta, 'fingerprint' | 'name' | 'owner' | 'last4'>, what: string) {
    this.of(e).lastUse = { at: this.at(), what };
  }

  /** GitHub refused a token for `what`; `bad` marks it unusable until it is rotated or a probe passes again. */
  noteError(e: Pick<VaultEntryMeta, 'fingerprint' | 'name' | 'owner' | 'last4'>, what: string, bad?: boolean) {
    const h = this.of(e);
    h.lastError = { at: this.at(), what };
    if (bad) h.bad = what;
    this.o.log?.(`github token ${e.name} …${e.last4}: ${what}`);
  }

  /** Every token's health, in the vault's order; a token not probed yet shows only its name. */
  list(): GithubTokenHealth[] {
    const v = this.o.vault();
    if (!v) return [];
    return v
      .list()
      .filter((e) => e.kind === 'github')
      .map((e) => ({ ...this.of(e), ...(e.disabled ? { disabled: true } : {}) }));
  }

  /**
   * The token a portal gh call for `person`'s work (no person: the system payer's) uses: theirs where
   * machines.githubFromVault has "portal" on and they have a usable one (else one shared with anyone); undefined means the
   * portal's own gh login. Never another person's own token.
   */
  tokenFor(person: string | undefined): { entry: VaultEntryMeta; token: string } | undefined {
    if (!githubFromVault(this.o.cfg, PORTAL_MACHINE)) return undefined;
    return this.o.vault()?.githubFor(person ?? this.o.payer?.(), this.usable);
  }

  /**
   * A gh runner for `person`'s work. With their token: a 401 marks it bad and the call is made again on the portal's own
   * login; a 403 is noted as the token's last error (a permission it lacks) and made again the same way, except a refused
   * statusCheckRollup, which no fine-grained token can read (the caller reads Actions runs instead).
   */
  runner(person: string | undefined, what: string): Runner {
    const run = this.o.run ?? runProc;
    return async (cmd, args, opts = {}) => {
      const plain = { ...(opts.env ?? process.env), GH_PROMPT_DISABLED: '1' };
      const t = this.tokenFor(person);
      if (!t) return run(cmd, args, { ...opts, env: plain });
      const r = await run(cmd, args, { ...opts, env: { ...plain, GH_TOKEN: t.token } });
      const said = `${r.stderr || r.stdout}`;
      if (r.code === 0) {
        this.noteUse(t.entry, what);
        return r;
      }
      if (NO_CHECKS.test(said) && DENIED.test(said)) return r;
      const refused = REFUSED.test(said);
      if (!refused && !DENIED.test(said)) return r;
      const line = said.trim().split('\n')[0].slice(0, 160);
      this.noteError(t.entry, `${what}: ${refused ? 'refused (401), not used again until it is rotated or passes a probe' : 'a permission is missing (403)'}: ${line}`, refused);
      return run(cmd, args, { ...opts, env: plain });
    };
  }

  /**
   * The token a machine's daemon pushes with for `person`'s work (a switch_branch's push, a released worker's save, w868):
   * their vault GitHub entry where machines.githubFromVault is on for the machine, as a run there would get it; else
   * undefined, the machine's own login.
   */
  forMachine(machineId: string, person: string | undefined, what: string): string | undefined {
    if (!githubFromVault(this.o.cfg, machineId)) return undefined;
    const s = this.o.vault()?.forRun({ machineId, role: 'workers', userId: person ?? this.o.payer?.() }, { claude: false, github: true, githubUsable: this.usable });
    if (!s?.github) return undefined;
    this.noteUse(s.github, what);
    return s.env.GH_TOKEN;
  }

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
    this.timer.unref?.();
    return this;
  }

  close() {
    clearInterval(this.timer);
  }

  /** Probe each token not probed within PROBE_EVERY_MS (a new or rotated one at once). */
  async tick(force = false): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      for (const { entry, token } of this.o.vault()?.githubTokens() ?? []) {
        const h = this.of(entry);
        if (!force && h.checkedAt && this.now() - Date.parse(h.checkedAt) < PROBE_EVERY_MS) continue;
        await this.probe(entry, token);
      }
    } finally {
      this.probing = false;
    }
  }

  /**
   * What GitHub says about one token: its account (GET /user, which needs no permission), its expiry (the
   * GitHub-Authentication-Token-Expiration header), and per repository whether it reads the repository (Metadata),
   * its files (Contents), pull requests, Actions runs and commit statuses. Write permissions cannot be read without
   * writing, so they are not probed. A fine-grained token's permissions are listed by no API a token can call.
   */
  async probe(entry: VaultEntryMeta, token: string): Promise<GithubTokenHealth> {
    const f = this.o.fetch ?? (globalThis.fetch as unknown as Fetch);
    const h = this.of(entry);
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ff-factory' };
    const get = async (p: string) => {
      try {
        return await f(`https://api.github.com/${p}`, { headers, signal: AbortSignal.timeout(20_000) });
      } catch {
        return undefined;
      }
    };
    const me = await get('user');
    h.checkedAt = this.at();
    if (!me) {
      h.lastError = { at: h.checkedAt, what: 'probe: GitHub did not answer' };
      return h;
    }
    if (me.status === 401) {
      this.noteError(entry, 'probe: GitHub refused it (401: revoked, expired or mistyped); rotate it', true);
      return h;
    }
    if (me.status !== 200) {
      h.lastError = { at: h.checkedAt, what: `probe: GitHub answered ${me.status} to GET /user` };
      return h;
    }
    delete h.bad;
    const exp = parseExpiry(me.headers.get('github-authentication-token-expiration'));
    if (exp) h.expiresAt = exp;
    else delete h.expiresAt;
    const u = (await me.json().catch(() => ({}))) as { login?: unknown; id?: unknown };
    if (typeof u.login === 'string') h.login = u.login;
    if (typeof u.id === 'number') h.userId = u.id;
    const repos: NonNullable<GithubTokenHealth['repos']> = [];
    for (const repo of this.o.repos?.() ?? GITHUB_REPOS) {
      const meta = await get(`repos/${repo}`);
      const m = meta ? access(meta.status) : 'error';
      if (m !== 'read') {
        repos.push({ repo, metadata: m });
        continue;
      }
      const one = async (p: string) => {
        const r = await get(`repos/${repo}/${p}`);
        return r ? access(r.status, 'denied') : 'error';
      };
      const contents = await one('commits?per_page=1');
      repos.push({
        repo,
        metadata: 'read',
        contents,
        pulls: await one('pulls?per_page=1&state=all'),
        actions: await one('actions/runs?per_page=1'),
        // An empty repository has no commit to ask about: its statuses read as denied there.
        statuses: contents === 'read' ? await one('commits/HEAD/status') : contents,
      });
    }
    h.repos = repos;
    return h;
  }

  /** system_status lines, one per GitHub token: whose, which account, expiry, reads, last use, last error. Never a value. */
  statusLines(): string[] {
    const on = githubFromVault(this.o.cfg, PORTAL_MACHINE);
    return this.list().map((h) => githubHealthLine(h, on, this.now()));
  }
}

/** One token's line (system_status, docs/vault.md section 13.4). */
export function githubHealthLine(h: GithubTokenHealth, portalOn: boolean, now: number): string {
  const parts = [`GitHub token ${h.name} …${h.last4}${h.owner ? ` (${h.owner}'s)` : ''}`];
  if (h.disabled) parts.push('disabled');
  if (!h.checkedAt) parts.push('not probed yet');
  else {
    if (h.login) parts.push(`GitHub account ${h.login}${h.userId ? ` (id ${h.userId})` : ''}`);
    if (h.bad) parts.push(`NOT USED: ${h.bad}`);
    if (h.expiresAt) {
      const days = Math.floor((Date.parse(h.expiresAt) - now) / 86_400_000);
      parts.push(days < 0 ? `EXPIRED ${h.expiresAt.slice(0, 10)}` : `expires ${h.expiresAt.slice(0, 10)} (${days} days)${days < 14 ? ': rotate it soon' : ''}`);
    } else if (!h.bad) parts.push('no expiry given');
    const missing = (h.repos ?? []).flatMap((r) => {
      if (r.metadata !== 'read') return [`${r.repo.split('/')[1]}: ${r.metadata === 'not-selected' ? 'not selected' : r.metadata}`];
      const lacks = (['contents', 'pulls', 'actions', 'statuses'] as const).filter((k) => r[k] !== 'read');
      return lacks.length ? [`${r.repo.split('/')[1]}: no ${lacks.join(', ')} read`] : [];
    });
    if (h.repos) parts.push(missing.length ? `reads lacking: ${missing.join('; ')}` : `reads ok on ${h.repos.length} repositories`);
    parts.push(`probed ${h.checkedAt.slice(0, 16)}Z`);
  }
  parts.push(h.lastUse ? `last used ${h.lastUse.at.slice(0, 16)}Z (${h.lastUse.what})` : 'not used since the portal started');
  if (h.lastError) parts.push(`last error ${h.lastError.at.slice(0, 16)}Z: ${h.lastError.what}`);
  if (!portalOn) parts.push('portal reads: off (machines.githubFromVault "portal")');
  return parts.join('; ');
}

let current: GithubTokens | undefined;
export const setGithubTokens = (g: GithubTokens | undefined) => {
  current = g;
};
export const githubTokens = () => current;

/**
 * The gh runner for the portal's calls on `person`'s work (`what` names the call for the token's last use). Without the
 * portal's GithubTokens (tests, the daemon), plain gh on the portal's own login.
 */
export function ghRunner(person: string | undefined, what: string): Runner {
  return current ? current.runner(person, what) : (cmd, args, opts = {}) => runProc(cmd, args, { ...opts, env: { ...process.env, ...opts.env, GH_PROMPT_DISABLED: '1' } });
}
