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
import { GITHUB_ORG, GITHUB_REQUIRED_PERMISSIONS, GITHUB_REQUIRED_REPOS, GITHUB_UNPROBED } from '../shared/githubRequirements.ts';

/** The machine id machines.githubFromVault uses for the portal's own GitHub reads. */
export const PORTAL_MACHINE = 'portal';

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

type Fetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
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
  /** The required repositories (config vault.githubRepos); default shared/githubRequirements.ts. */
  repos?: () => readonly string[];
  /** Probe the portal's own gh login (D7) too (default yes; tests without gh say no). */
  probePortalLogin?: boolean;
  /** A loud notice ([host] to the dispatcher, the host notification) when a credential turns bad or recovers (w904). */
  report?: (title: string, body: string) => void;
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

  /** Every token's health, in the vault's order, then the portal's login once probed, each with what it lacks (githubProblems). */
  list(): GithubTokenHealth[] {
    const tokens = (this.o.vault()?.list() ?? []).filter((e) => e.kind === 'github').map((e) => ({ ...this.of(e), ...(e.disabled ? { disabled: true } : {}) }));
    const portal = this.health.get(PORTAL_LOGIN.fingerprint);
    return [...tokens, ...(portal?.checkedAt ? [portal] : [])].map((h) => ({ ...h, problems: githubProblems(h, this.repos(), this.now()) }));
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

  /**
   * Probe each token not probed within PROBE_EVERY_MS (a new or rotated one at once), and the portal's own gh login (D7)
   * the same way; `force` probes all now (the vault page's "Re-check now"). Reports each one that turns bad or recovers.
   */
  async tick(force = false): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      for (const { entry, token } of this.o.vault()?.githubTokens() ?? []) {
        const h = this.of(entry);
        if (!force && h.checkedAt && this.now() - Date.parse(h.checkedAt) < PROBE_EVERY_MS) continue;
        await this.probe(entry, token);
      }
      if (this.o.probePortalLogin !== false) {
        const h = this.of(PORTAL_LOGIN);
        h.portal = true;
        if (force || !h.checkedAt || this.now() - Date.parse(h.checkedAt) >= PROBE_EVERY_MS) await this.probeWith(h, ghReader(this.o.run ?? runProc));
      }
    } finally {
      this.probing = false;
    }
    this.reportChanges();
  }

  /** When the last probe ran on any token, for "Re-check now" (it may not run more often than RECHECK_MIN_MS). */
  private lastForced = 0;

  /** "Re-check now" (w904): every token and the portal login at once, at most every RECHECK_MIN_MS; false when refused for that. */
  async recheck(): Promise<boolean> {
    if (this.now() - this.lastForced < RECHECK_MIN_MS) return false;
    this.lastForced = this.now();
    await this.tick(true);
    return true;
  }

  /** The [host] notice when a token turns bad (or its problems change) and when it recovers; said once per change. */
  private readonly reported = new Map<string, string>();
  private reportChanges() {
    for (const h of this.list()) {
      if (!h.checkedAt) continue;
      const sig = (h.problems ?? []).join('; ');
      const before = this.reported.get(h.fingerprint);
      if (sig === (before ?? '')) continue;
      this.reported.set(h.fingerprint, sig);
      if (sig) this.o.report?.(`${tokenName(h)} needs updating on GitHub`, githubBannerText(h));
      else if (before) this.o.report?.(`${tokenName(h)} has everything it needs again`, githubHealthLine(h, true, this.now()));
    }
  }

  /** What GitHub says about one vault token (probeWith), read with the token itself. */
  async probe(entry: VaultEntryMeta, token: string): Promise<GithubTokenHealth> {
    return this.probeWith(this.of(entry), fetchReader(token, this.o.fetch ?? (globalThis.fetch as unknown as Fetch)));
  }

  /**
   * What GitHub says about one credential: its account (GET /user, which needs no permission), its expiry (the
   * GitHub-Authentication-Token-Expiration header), the organization's Self-hosted runners and Artifact metadata reads, and
   * per required repository (config vault.githubRepos) whether it is reachable (Metadata) and each permission's read half
   * (shared/githubRequirements.ts). Write halves are not probed: that would mean writing. No API a token can call lists a
   * fine-grained token's permissions, so each read is a real request whose answer is the measurement.
   */
  async probeWith(h: GithubTokenHealth, r: GithubReader): Promise<GithubTokenHealth> {
    const me = await r.get('user');
    h.checkedAt = new Date(this.now()).toISOString();
    if (!me) {
      h.lastError = { at: h.checkedAt, what: 'probe: GitHub did not answer' };
      return h;
    }
    if (me.status === 401) {
      h.lastError = { at: h.checkedAt, what: 'probe: GitHub refused it (401: revoked, expired or mistyped); rotate it' };
      h.bad = h.lastError.what;
      this.o.log?.(`github token ${tokenName(h)}: ${h.bad}`);
      return h;
    }
    if (me.status !== 200) {
      h.lastError = { at: h.checkedAt, what: `probe: GitHub answered ${me.status} to GET /user` };
      return h;
    }
    delete h.bad;
    const exp = parseExpiry(me.header('github-authentication-token-expiration'));
    if (exp) h.expiresAt = exp;
    else delete h.expiresAt;
    const u = (await me.json().catch(() => ({}))) as { login?: unknown; id?: unknown };
    if (typeof u.login === 'string') h.login = u.login;
    if (typeof u.id === 'number') h.userId = u.id;
    const status = async (p: string, notFound: GithubAccess) => {
      const x = await r.get(p);
      return x ? access(x.status, notFound) : 'error';
    };
    h.org = {
      'self-hosted-runners': await status(`orgs/${GITHUB_ORG}/actions/runners?per_page=1`, 'denied'),
      // An unknown digest: 404 when the read is allowed, 403 when refused (measured with a token that may read: 404).
      'artifact-metadata': await status(`orgs/${GITHUB_ORG}/artifacts/sha256:${'0'.repeat(64)}/metadata/storage-records`, 'read'),
    };
    const repos: NonNullable<GithubTokenHealth['repos']> = [];
    for (const repo of this.repos()) {
      const meta = await status(`repos/${repo}`, 'not-selected');
      if (meta !== 'read') {
        repos.push({ repo, access: { metadata: meta } });
        continue;
      }
      const contents = await status(`repos/${repo}/commits?per_page=1`, 'denied');
      const [owner, name] = repo.split('/');
      repos.push({
        repo,
        access: {
          metadata: 'read',
          contents,
          'pull-requests': await status(`repos/${repo}/pulls?per_page=1&state=all`, 'denied'),
          actions: await status(`repos/${repo}/actions/runs?per_page=1`, 'denied'),
          issues: await status(`repos/${repo}/issues?per_page=1&state=all`, 'denied'),
          // An empty repository has no commit to ask about (409): its statuses are not counted against the token.
          'commit-statuses': contents === 'read' ? await status(`repos/${repo}/commits/HEAD/status`, 'denied') : 'error',
          discussions: await r.graphql(`query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){discussions(first:1){totalCount}}}`),
        },
      });
    }
    h.repos = repos;
    return h;
  }

  private repos(): readonly string[] {
    return this.o.repos?.() ?? GITHUB_REQUIRED_REPOS;
  }

  /** system_status lines, one per GitHub token and the portal login: WARNING when something required is missing. Never a value. */
  statusLines(): string[] {
    const on = githubFromVault(this.o.cfg, PORTAL_MACHINE);
    return this.list().map((h) => `${h.problems?.length ? 'WARNING: ' : ''}${githubHealthLine(h, on, this.now())}`);
  }

  /** The dashboard banners (w904): one per token missing something, for owners and the token's own person. */
  banners(): { id: string; person?: string; text: string }[] {
    return this.list()
      .filter((h) => h.problems?.length)
      .map((h) => ({ id: `github:${h.fingerprint}`, ...(h.owner ? { person: h.owner } : {}), text: githubBannerText(h) }));
  }
}

/** The portal's own gh login (D7), probed beside the vault tokens through gh itself: the portal never holds its value. */
export const PORTAL_LOGIN = { fingerprint: 'portal-login', name: "the portal's own gh login (D7)", last4: '' } as const;

/** Re-check now runs at most this often (each probe is about 75 GitHub reads per token). */
export const RECHECK_MIN_MS = 30_000;

/** How a credential is named everywhere: "vault-ben-github …abcd", or the portal's login. */
export const tokenName = (h: Pick<GithubTokenHealth, 'name' | 'last4'>) => (h.last4 ? `${h.name} …${h.last4}` : h.name);

/** One answer of a probe read. */
interface Answer {
  status: number;
  header(name: string): string | null;
  json(): Promise<unknown>;
}

/** How a probe reads GitHub: a vault token over fetch, or the portal's gh login. */
export interface GithubReader {
  get(path: string): Promise<Answer | undefined>;
  /** A GraphQL read: read, denied ("Resource not accessible"), or error. */
  graphql(query: string): Promise<GithubAccess>;
}

const HEADERS = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ff-factory' });

/** A reader with a vault token: the token goes in the Authorization header only. */
export function fetchReader(token: string, f: Fetch): GithubReader {
  return {
    get: async (p) => {
      try {
        const x = await f(`https://api.github.com/${p}`, { headers: HEADERS(token), signal: AbortSignal.timeout(20_000) });
        return { status: x.status, header: (n) => x.headers.get(n), json: () => x.json() };
      } catch {
        return undefined;
      }
    },
    graphql: async (query) => {
      try {
        const x = await f('https://api.github.com/graphql', { method: 'POST', headers: { ...HEADERS(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000) });
        if (x.status === 401 || x.status === 403) return 'denied';
        const b = (await x.json().catch(() => ({}))) as { errors?: { message?: string; type?: string }[]; data?: unknown };
        if (b.errors?.some((e) => /not accessible|FORBIDDEN/i.test(`${e.message} ${e.type}`))) return 'denied';
        return x.status === 200 && b.data ? 'read' : 'error';
      } catch {
        return 'error';
      }
    },
  };
}

/** `gh api -i` output: the status line, the headers, a blank line, the body (measured: printed on errors too, exit 1). */
export function parseGhInclude(out: string): Answer | undefined {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(out.replace(/\r\n/g, '\n'));
  if (!m) return undefined;
  const headers = new Map(m[2].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()] as const));
  return { status: Number(m[1]), header: (n) => headers.get(n.toLowerCase()) ?? null, json: async () => JSON.parse(m[3] || 'null') };
}

/** A reader on the portal's own gh login (D7): gh reads its own credential; nothing here sees it. */
export function ghReader(run: Runner): GithubReader {
  const env = () => {
    const e: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1' };
    delete e.GH_TOKEN;
    return e;
  };
  return {
    get: async (p) => {
      const r = await run('gh', ['api', '-i', p], { timeoutMs: 30_000, env: env() });
      return parseGhInclude(r.stdout) ?? (r.code === 0 ? undefined : parseGhInclude(r.stderr));
    },
    graphql: async (query) => {
      const r = await run('gh', ['api', 'graphql', '-f', `query=${query}`], { timeoutMs: 30_000, env: env() });
      if (r.code === 0) return 'read';
      return /not accessible|FORBIDDEN|HTTP 403/i.test(`${r.stderr}${r.stdout}`) ? 'denied' : 'error';
    },
  };
}

/**
 * What a credential lacks of shared/githubRequirements.ts, as a person fixes it: refused or expired, near its expiry, a
 * repository not selected, a permission's read refused (all repositories at once when it is every one). Reads that got no
 * answer are not counted: a network blip is not the token's fault.
 */
export function githubProblems(h: GithubTokenHealth, repos: readonly string[], now: number): string[] {
  if (!h.checkedAt || h.disabled) return [];
  const out: string[] = [];
  if (h.bad) return [`GitHub refused it (401): revoked, expired or mistyped`];
  if (h.expiresAt) {
    const days = Math.floor((Date.parse(h.expiresAt) - now) / 86_400_000);
    if (days < 0) out.push(`expired ${h.expiresAt.slice(0, 10)}`);
    else if (days < 14) out.push(`expires ${h.expiresAt.slice(0, 10)} (in ${days} days)`);
  }
  if (!h.repos) return out;
  for (const p of GITHUB_REQUIRED_PERMISSIONS.filter((x) => x.scope === 'organization' || x.id === 'artifact-metadata')) {
    if (h.org?.[p.id] === 'denied') out.push(`${p.label} (organization ${GITHUB_ORG}): read refused`);
  }
  const probed = h.repos.filter((r) => repos.includes(r.repo));
  for (const r of probed) {
    if (r.access.metadata === 'not-selected') out.push(`${r.repo}: not selected`);
    else if (r.access.metadata === 'denied') out.push(`${r.repo}: refused (403)`);
  }
  const reachable = probed.filter((r) => r.access.metadata === 'read');
  for (const p of GITHUB_REQUIRED_PERMISSIONS.filter((x) => x.scope === 'repository' && x.probe && x.id !== 'metadata' && x.id !== 'artifact-metadata')) {
    const refused = reachable.filter((r) => r.access[p.id] === 'denied').map((r) => r.repo.split('/')[1]);
    if (!refused.length) continue;
    out.push(`${p.label}: read refused ${refused.length === reachable.length ? 'on every repository' : `on ${refused.join(', ')}`}`);
  }
  return out;
}

/** The banner (w904): the token, what it lacks, and the fix; never a value. */
export function githubBannerText(h: GithubTokenHealth): string {
  const fix = h.portal
    ? `Edit the portal's token on github.com (Settings, Developer settings, Fine-grained tokens): Repository access and Permissions. Its value stays`
    : h.bad
      ? `Make a new token on github.com with the settings of docs/vault.md 13.2 and put it in the host's people/${h.owner ?? '<person>'}/github-token, then sudo fff-vm vault-sync`
      : `Edit the token on github.com (Settings, Developer settings, Fine-grained tokens): Repository access and Permissions. Its value stays, so nothing changes in the vault`;
  return `${tokenName(h)}${h.login ? ` (GitHub ${h.login})` : ''} lacks: ${(h.problems ?? []).join('; ')}. ${fix}; the probe reads it again within 6 hours, or at once with Re-check now on Settings, Token vault. Not checked (they cannot be read without writing): ${GITHUB_UNPROBED}.`;
}

/** One credential's line (system_status, docs/vault.md section 13.6). */
export function githubHealthLine(h: GithubTokenHealth, portalOn: boolean, now: number): string {
  const parts = [`GitHub token ${tokenName(h)}${h.owner ? ` (${h.owner}'s)` : ''}`];
  if (h.disabled) parts.push('disabled');
  if (!h.checkedAt) parts.push('not probed yet');
  else {
    if (h.login) parts.push(`GitHub account ${h.login}${h.userId ? ` (id ${h.userId})` : ''}`);
    if (h.bad) parts.push(`NOT USED: ${h.bad}`);
    if (h.expiresAt) {
      const days = Math.floor((Date.parse(h.expiresAt) - now) / 86_400_000);
      parts.push(days < 0 ? `EXPIRED ${h.expiresAt.slice(0, 10)}` : `expires ${h.expiresAt.slice(0, 10)} (${days} days)${days < 14 ? ': rotate it soon' : ''}`);
    } else if (!h.bad) parts.push('no expiry given');
    const lacking = (h.problems ?? []).filter((p) => !/^expire|^GitHub refused/.test(p));
    if (h.repos) parts.push(lacking.length ? `lacks: ${lacking.join('; ')}` : `has every required read on ${h.repos.length} repositories`);
    parts.push(`probed ${h.checkedAt.slice(0, 16)}Z`);
  }
  if (!h.portal) parts.push(h.lastUse ? `last used ${h.lastUse.at.slice(0, 16)}Z (${h.lastUse.what})` : 'not used since the portal started');
  if (h.lastError) parts.push(`last error ${h.lastError.at.slice(0, 16)}Z: ${h.lastError.what}`);
  if (!portalOn && !h.portal) parts.push('portal reads: off (machines.githubFromVault "portal")');
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
