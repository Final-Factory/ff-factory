// GitHub Apps (w1519, docs/github-apps.md). lothsahn: "I'd like you to add support for this and let me know what i need to do
// to make an app that Gherik can add". A fine-grained token reaches only its owner's repositories, so a modder's private
// repositories (Gherik1/ItemCannon, Gherik1/PlayerUpgrades) are reached through a GitHub App the modder installs on them:
//
// - the vault keeps the app (kind github-app): its private key sealed like a token, its App ID and the accounts whose
//   installations are used (appOwners, the allowlist: a public app can be installed by anyone, and any other installation is
//   ignored, or uninstalled with uninstallOthers);
// - this module signs a JWT with the key (RS256, at most 10 minutes), lists the app's installations, and mints each allowed
//   installation's token (POST /app/installations/{id}/access_tokens, valid 1 hour), replacing it 15 minutes before its end;
// - routing: a repository an allowed installation covers gets its token (the portal's gh calls, and the machines' workers
//   through their daemon: machine/ghApp.ts); every other repository keeps the person's own token, as before;
// - health: the key, the installations, what each grants against shared/githubRequirements.ts GITHUB_APP_PERMISSIONS.
// Neither the key nor a token is ever logged: names, the key's last four, installation ids and accounts only.
import { createSign } from 'node:crypto';
import { eligible, type Vault, type VaultEntryMeta } from './vault.ts';
import type { GithubAppHealth } from '../shared/types.ts';
import { GITHUB_APP_PERMISSIONS, appAccessCovers } from '../shared/githubRequirements.ts';
import { appTokenFor, type GhAppToken } from '../shared/githubAppRoute.ts';

/** A token is replaced once it has less than this left (it lives 1 hour; the tick runs every 5 minutes). */
export const REFRESH_BEFORE_MS = 15 * 60_000;
/** The app and its installations are read again this often (a new installation, a permission accepted). */
export const APP_READ_EVERY_MS = 60 * 60_000;
export const APP_TICK_MS = 5 * 60_000;

/** What an app's installations depend on: its key, App ID, allowlist, pinned installations and uninstall-others (w1519). */
const readKey = (e: VaultEntryMeta) => JSON.stringify([e.fingerprint, e.appId, e.appOwners, e.installations, !!e.uninstallOthers]);

type Fetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * The app's JWT (sourced: docs.github.com "Generating a JSON Web Token (JWT) for a GitHub App"): RS256, issued 60 seconds in
 * the past against clock drift, expiring at most 10 minutes on (here 9), the App ID (a number) or Client ID as issuer.
 */
export function appJwt(appId: string, pem: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: /^\d+$/.test(appId) ? Number(appId) : appId }));
  const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(pem);
  return `${header}.${payload}.${b64url(sig)}`;
}

const HEADERS = (auth: string) => ({ Authorization: `Bearer ${auth}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ff-factory' });

interface Install {
  id: number;
  account: string;
  allowed: boolean;
  selection?: 'all' | 'selected';
  permissions?: Record<string, string>;
  suspended?: boolean;
  uninstalledAt?: string;
  repos?: string[];
  token?: { value: string; expiresAt: string };
}

interface AppState {
  health: GithubAppHealth;
  /** The key and settings the installations were read with (readKey): a rotated key or a changed allowlist reads again at once. */
  readWith?: string;
  readAt?: number;
  /** The app's own permissions (GET /app): what an installation is asked to accept. */
  asks?: Record<string, string>;
  installs: Install[];
}

export interface GithubAppsOptions {
  vault: () => Vault | undefined;
  fetch?: Fetch;
  now?: () => number;
  log?: (line: string) => void;
  /** A loud notice when an app turns bad or recovers, or an installation is uninstalled (as GithubTokens reports). */
  report?: (title: string, body: string) => void;
  /** Each new installation token, for redaction (server/secrets.ts addSecretValues), before anything can print it. */
  secret?: (value: string) => void;
  /** A token was minted or dropped: the machines get the new set (server/machines.ts pushGhAppTokens). */
  onTokens?: () => void;
}

export class GithubApps {
  private readonly o: GithubAppsOptions;
  /** By entry name: a rotated key keeps its app's state and is read again. */
  private readonly state = new Map<string, AppState>();
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;

  constructor(o: GithubAppsOptions) {
    this.o = o;
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  private at() {
    return new Date(this.now()).toISOString();
  }

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), APP_TICK_MS);
    this.timer.unref?.();
    return this;
  }

  close() {
    clearInterval(this.timer);
  }

  private of(e: VaultEntryMeta): AppState {
    let s = this.state.get(e.name);
    if (!s) {
      s = { health: { fingerprint: e.fingerprint, name: e.name, last4: e.last4 }, installs: [] };
      this.state.set(e.name, s);
    }
    Object.assign(s.health, { fingerprint: e.fingerprint, last4: e.last4, appId: e.appId, ...(e.owner ? { owner: e.owner } : {}) });
    return s;
  }

  /**
   * Read each app when due (never read, its key rotated, APP_READ_EVERY_MS on, or `force`), then mint the tokens that are
   * missing or near their end. One tick at a time; a second caller waits for the one running.
   */
  tick(force = false): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.run(force).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async run(force: boolean) {
    const apps = this.o.vault()?.githubApps() ?? [];
    let changed = false;
    for (const name of [...this.state.keys()]) {
      if (apps.some((a) => a.entry.name === name)) continue;
      changed ||= this.state.get(name)!.installs.some((i) => i.token);
      this.state.delete(name);
    }
    for (const { entry, key } of apps) {
      const s = this.of(entry);
      try {
        if (force || s.readWith !== readKey(entry) || !s.readAt || this.now() - s.readAt >= APP_READ_EVERY_MS) changed = (await this.read(s, entry, key)) || changed;
        if (!s.health.bad) changed = (await this.mint(s, entry, key)) || changed;
      } catch (e) {
        s.health.lastError = { at: this.at(), what: `read failed: ${(e as Error).message.slice(0, 160)}` };
      }
    }
    this.reportChanges();
    if (changed) this.o.onTokens?.();
  }

  private async call(method: string, path: string, auth: string, body?: unknown): Promise<{ status: number; json: unknown } | undefined> {
    const f = this.o.fetch ?? (globalThis.fetch as unknown as Fetch);
    try {
      const x = await f(`https://api.github.com/${path}`, {
        method,
        headers: { ...HEADERS(auth), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      return { status: x.status, json: x.status === 204 ? undefined : await x.json().catch(() => undefined) };
    } catch {
      return undefined;
    }
  }

  /** GET /app and its installations; uninstalls the ones off the allowlist when the entry asks. True when a token was dropped. */
  private async read(s: AppState, e: VaultEntryMeta, key: string): Promise<boolean> {
    const h = s.health;
    const jwt = appJwt(e.appId ?? '', key, this.now());
    const me = await this.call('GET', 'app', jwt);
    h.checkedAt = this.at();
    if (!me) {
      h.lastError = { at: h.checkedAt, what: 'GitHub did not answer GET /app' };
      return false;
    }
    if (me.status === 401) {
      // A wrong App ID, or a key deleted on GitHub: nothing of this app is used until a read passes.
      h.bad = `GitHub refused its JWT (401): the App ID ${e.appId} is wrong or the key was deleted on GitHub`;
      h.lastError = { at: h.checkedAt, what: h.bad };
      this.o.log?.(`github app ${e.name} …${e.last4}: ${h.bad}`);
      const dropped = s.installs.some((i) => i.token);
      s.installs = [];
      s.readWith = readKey(e);
      s.readAt = this.now();
      return dropped;
    }
    if (me.status !== 200) {
      h.lastError = { at: h.checkedAt, what: `GitHub answered ${me.status} to GET /app` };
      return false;
    }
    delete h.bad;
    const app = (me.json ?? {}) as { slug?: string; owner?: { login?: string }; permissions?: Record<string, string> };
    h.slug = app.slug;
    h.appOwner = app.owner?.login;
    s.asks = app.permissions ?? {};
    const listed: { id: number; account?: { login?: string }; repository_selection?: 'all' | 'selected'; permissions?: Record<string, string>; suspended_at?: string | null }[] = [];
    for (let page = 1; page <= 5; page++) {
      const r = await this.call('GET', `app/installations?per_page=100&page=${page}`, jwt);
      if (!r || r.status !== 200 || !Array.isArray(r.json)) {
        h.lastError = { at: this.at(), what: `GitHub answered ${r?.status ?? 'nothing'} to GET /app/installations` };
        return false;
      }
      listed.push(...(r.json as typeof listed));
      if (r.json.length < 100) break;
    }
    const allowedOwners = (e.appOwners ?? []).map((o) => o.toLowerCase());
    const before = new Map(s.installs.map((i) => [i.id, i]));
    const next: Install[] = [];
    for (const x of listed) {
      const account = x.account?.login ?? '?';
      const allowed = allowedOwners.includes(account.toLowerCase()) && (!e.installations?.length || e.installations.includes(x.id));
      const was = before.get(x.id);
      const i: Install = { id: x.id, account, allowed, selection: x.repository_selection, permissions: x.permissions ?? {}, ...(x.suspended_at ? { suspended: true } : {}) };
      if (allowed && was?.token && !i.suspended) Object.assign(i, { token: was.token, repos: was.repos });
      if (!allowed && e.uninstallOthers) {
        // Off the allowlist and the entry says so: removed from that account (sourced: REST "Delete an installation for the
        // authenticated app", JWT only; its success code read 202 on 2026-10-19, so any 2xx counts). It may install again; it is
        // removed again.
        const del = await this.call('DELETE', `app/installations/${x.id}`, jwt);
        if (del && del.status >= 200 && del.status < 300) {
          i.uninstalledAt = this.at();
          const line = `uninstalled ${h.slug ?? e.name} from ${account} (installation ${x.id}): not on the allowlist (${(e.appOwners ?? []).join(', ')})`;
          this.o.log?.(`github app ${e.name}: ${line}`);
          this.o.report?.(`GitHub App ${e.name}: ${line}`, `${line}. The vault entry has uninstallOthers on; docs/github-apps.md, "Who may install it".`);
          continue;
        }
        h.lastError = { at: this.at(), what: `could not uninstall from ${account} (installation ${x.id}): GitHub answered ${del?.status ?? 'nothing'}` };
      }
      next.push(i);
    }
    const dropped = s.installs.some((i) => i.token && !next.some((n) => n.id === i.id && n.token));
    s.installs = next;
    s.readWith = readKey(e);
    s.readAt = this.now();
    return dropped;
  }

  /** A token for each allowed installation that has none or is near its end, with the repositories it covers. True when any changed. */
  private async mint(s: AppState, e: VaultEntryMeta, key: string): Promise<boolean> {
    let changed = false;
    let jwt: string | undefined;
    for (const i of s.installs) {
      if (!i.allowed || i.suspended) continue;
      if (i.token && Date.parse(i.token.expiresAt) - this.now() > REFRESH_BEFORE_MS) continue;
      jwt ??= appJwt(e.appId ?? '', key, this.now());
      const r = await this.call('POST', `app/installations/${i.id}/access_tokens`, jwt);
      const t = (r?.json ?? {}) as { token?: string; expires_at?: string; permissions?: Record<string, string>; repository_selection?: 'all' | 'selected' };
      if (r?.status !== 201 || typeof t.token !== 'string' || typeof t.expires_at !== 'string') {
        s.health.lastError = { at: this.at(), what: `no token for ${i.account}'s installation ${i.id}: GitHub answered ${r?.status ?? 'nothing'}` };
        if (r?.status === 401) s.health.bad = `GitHub refused its JWT (401) minting a token: the App ID ${e.appId} is wrong or the key was deleted on GitHub`;
        if (r?.status === 404 || r?.status === 401) {
          changed ||= !!i.token;
          delete i.token;
          s.readAt = undefined;
        }
        continue;
      }
      this.o.secret?.(t.token);
      i.token = { value: t.token, expiresAt: new Date(Date.parse(t.expires_at)).toISOString() };
      if (t.permissions) i.permissions = t.permissions;
      if (t.repository_selection) i.selection = t.repository_selection;
      i.repos = await this.repos(t.token);
      changed = true;
    }
    return changed;
  }

  /** The repositories an installation token covers (GET /installation/repositories), "owner/name" in lower case. */
  private async repos(token: string): Promise<string[] | undefined> {
    const out: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.call('GET', `installation/repositories?per_page=100&page=${page}`, token);
      const list = (r?.json as { repositories?: { full_name?: string }[] } | undefined)?.repositories;
      if (r?.status !== 200 || !Array.isArray(list)) return out.length ? out : undefined;
      out.push(...list.map((x) => (x.full_name ?? '').toLowerCase()).filter(Boolean));
      if (list.length < 100) break;
    }
    return out;
  }

  /** The live tokens of the apps `use` accepts, as machines and routing take them. Never logged. */
  private tokens(use: (e: VaultEntryMeta) => boolean): GhAppToken[] {
    const entries = new Map((this.o.vault()?.list() ?? []).filter((e) => e.kind === 'github-app' && !e.disabled).map((e) => [e.name, e]));
    const out: GhAppToken[] = [];
    for (const [name, s] of this.state) {
      const e = entries.get(name);
      if (!e || s.health.bad || !use(e)) continue;
      for (const i of s.installs) {
        if (!i.allowed || i.suspended || !i.token || Date.parse(i.token.expiresAt) <= this.now()) continue;
        out.push({ app: name, repos: i.repos ?? [], owners: i.selection === 'all' ? [i.account.toLowerCase()] : [], token: i.token.value, expiresAt: i.token.expiresAt });
      }
    }
    return out;
  }

  /**
   * What a machine's daemon keeps for its runs (w1519): the tokens of every app granted to that machine (any role, any person);
   * each run then uses only the apps its own grant allows (FF_GH_APP_NAMES, machineRunEnv). Empty when none.
   */
  forMachine(machineId: string): GhAppToken[] {
    const id = machineId.toLowerCase();
    return this.tokens((e) => e.machines.includes('*') || e.machines.includes(id));
  }

  /**
   * The token for the portal's gh call on `repo` for `person`'s work: an app whose allowed installation covers the repository,
   * that the person may use (its owner's work, or shared with anyone). Undefined: the person's own token, as for any repository.
   */
  forPortal(person: string | undefined, repo: string | undefined): GhAppToken | undefined {
    const tokens = this.tokens((e) => eligible(e, { machineId: 'portal', role: 'orchestrator', userId: person }));
    return appTokenFor(tokens, repo, tokens.map((t) => t.app), this.now());
  }

  /** An app token was used for `what`. */
  noteUse(name: string, what: string) {
    const s = this.state.get(name);
    if (s) s.health.lastUse = { at: this.at(), what };
  }

  /** GitHub refused an app token for `what`: noted, and with `stale` its token is minted again at the next tick. */
  noteError(name: string, what: string, stale = false) {
    const s = this.state.get(name);
    if (!s) return;
    s.health.lastError = { at: this.at(), what };
    this.o.log?.(`github app ${name} …${s.health.last4}: ${what}`);
    if (stale) for (const i of s.installs) delete i.token;
  }

  /** Every app's health, in the vault's order, with what it lacks (githubAppProblems). */
  list(): GithubAppHealth[] {
    return (this.o.vault()?.list() ?? [])
      .filter((e) => e.kind === 'github-app')
      .map((e) => {
        const s = this.of(e);
        const h: GithubAppHealth = {
          ...s.health,
          ...(e.disabled ? { disabled: true } : {}),
          ...(s.health.checkedAt
            ? {
                installations: s.installs.map((i) => ({
                  id: i.id,
                  account: i.account,
                  allowed: i.allowed,
                  ...(i.selection ? { selection: i.selection } : {}),
                  ...(i.allowed && i.repos ? { repos: i.repos } : {}),
                  ...(i.permissions ? { permissions: i.permissions } : {}),
                  ...(i.suspended ? { suspended: true } : {}),
                  ...(i.token ? { tokenExpiresAt: i.token.expiresAt } : {}),
                  ...(i.uninstalledAt ? { uninstalledAt: i.uninstalledAt } : {}),
                })),
              }
            : {}),
        };
        return { ...h, problems: githubAppProblems(h, e.appOwners ?? [], s.asks) };
      });
  }

  /** system_status lines, one per app: WARNING when it lacks something. Never a key or a token. */
  statusLines(): string[] {
    return this.list().map((h) => `${h.problems?.length ? 'WARNING: ' : ''}${githubAppHealthLine(h)}`);
  }

  /** The dashboard banners, one per app that lacks something (the kind the GitHub token banners use). */
  banners(): { id: string; kind: 'github-token'; person?: string; text: string }[] {
    return this.list()
      .filter((h) => h.problems?.length)
      .map((h) => ({ id: `github-app:${h.name}`, kind: 'github-token' as const, ...(h.owner ? { person: h.owner } : {}), text: githubAppBannerText(h) }));
  }

  /** The notice when an app turns bad (or its problems change) and when it recovers; said once per change. */
  private readonly reported = new Map<string, string>();
  private reportChanges() {
    for (const h of this.list()) {
      if (!h.checkedAt) continue;
      const sig = (h.problems ?? []).join('; ');
      const before = this.reported.get(h.name);
      if (sig === (before ?? '')) continue;
      this.reported.set(h.name, sig);
      if (sig) this.o.report?.(`GitHub App ${h.name} needs attention`, githubAppBannerText(h));
      else if (before) this.o.report?.(`GitHub App ${h.name} has everything it needs again`, githubAppHealthLine(h));
    }
  }
}

const label = (id: string) => GITHUB_APP_PERMISSIONS.find((p) => p.id === id)?.label ?? id;
const accessWords = (a: 'read' | 'write') => (a === 'write' ? 'read and write' : 'read-only');

/**
 * What an app lacks, as a person fixes it: its key refused; no allowed installation (the owner has not installed it); an
 * allowed installation suspended, on no repository, or without a required permission (the app does not ask for it, or the
 * account has not accepted it yet). Installations off the allowlist are not problems: the health line lists them.
 */
export function githubAppProblems(h: GithubAppHealth, owners: readonly string[], asks: Record<string, string> = {}): string[] {
  if (!h.checkedAt || h.disabled) return [];
  if (h.bad) return [h.bad];
  const out: string[] = [];
  const allowed = (h.installations ?? []).filter((i) => i.allowed);
  const install = h.slug ? `https://github.com/apps/${h.slug}/installations/new` : "the app's public page";
  if (!allowed.length) out.push(`not installed on ${owners.join(' or ')}: they install it from ${install} and select the repositories`);
  for (const i of allowed) {
    if (i.suspended) out.push(`${i.account}'s installation ${i.id} is suspended: ${i.account} unsuspends it (Settings, Applications)`);
    if (i.repos && !i.repos.length && i.selection !== 'all') out.push(`${i.account}'s installation ${i.id} covers no repository: ${i.account} selects them (Settings, Applications, Configure)`);
    for (const p of GITHUB_APP_PERMISSIONS.filter((x) => !x.optional)) {
      if (appAccessCovers(i.permissions?.[p.id], p.access)) continue;
      out.push(
        appAccessCovers(asks[p.id], p.access)
          ? `${p.label} (${accessWords(p.access)}) not accepted yet on ${i.account}'s installation: ${i.account} accepts the new permissions (Settings, Applications, the app, Review request)`
          : `${p.label} (${accessWords(p.access)}) is not asked for: set it on the app's settings (Permissions and events), then ${i.account} accepts it`,
      );
    }
  }
  return out;
}

/** One app's line (system_status, the vault page): the key, each installation, what is ignored, the token's expiry. Never a value. */
export function githubAppHealthLine(h: GithubAppHealth): string {
  const parts = [`GitHub App ${h.name} …${h.last4}${h.owner ? ` (${h.owner}'s)` : ''}${h.appId ? `, App ID ${h.appId}` : ''}${h.slug ? `, ${h.slug}` : ''}${h.appOwner ? ` owned by ${h.appOwner}` : ''}`];
  if (h.disabled) parts.push('disabled');
  if (!h.checkedAt) parts.push('not read yet');
  else if (h.bad) parts.push(`NOT USED: ${h.bad}`);
  else {
    parts.push('key valid');
    const all = h.installations ?? [];
    for (const i of all.filter((x) => x.allowed)) {
      const grants = Object.entries(i.permissions ?? {}).sort().map(([k, v]) => `${label(k)} ${v}`).join(', ');
      const repos = i.selection === 'all' ? `every repository of ${i.account}` : `${i.repos?.length ?? '?'} repositories${i.repos?.length ? ` (${i.repos.join(', ')})` : ''}`;
      parts.push(`${i.account} (installation ${i.id}${i.suspended ? ', SUSPENDED' : ''}): ${repos}; grants ${grants || 'nothing'}${i.tokenExpiresAt ? `; token until ${i.tokenExpiresAt.slice(11, 16)}Z` : ''}`);
    }
    const ignored = all.filter((x) => !x.allowed);
    if (ignored.length) parts.push(`ignored, not on the allowlist: ${ignored.map((i) => `${i.account} (installation ${i.id}${i.uninstalledAt ? ', uninstalled' : ''})`).join(', ')}`);
    const lacking = h.problems ?? [];
    if (lacking.length) parts.push(`lacks: ${lacking.join('; ')}`);
    parts.push(`read ${h.checkedAt.slice(0, 16)}Z`);
  }
  parts.push(h.lastUse ? `last used ${h.lastUse.at.slice(0, 16)}Z (${h.lastUse.what})` : 'not used since the portal started');
  if (h.lastError) parts.push(`last error ${h.lastError.at.slice(0, 16)}Z: ${h.lastError.what}`);
  return parts.join('; ');
}

/** The banner: the app, what it lacks, where it is fixed (docs/github-apps.md). Never a value. */
export function githubAppBannerText(h: GithubAppHealth): string {
  return `GitHub App ${h.name} …${h.last4}${h.slug ? ` (${h.slug})` : ''} lacks: ${(h.problems ?? []).join('; ')}. Steps: docs/github-apps.md; the portal reads it again within the hour, or at once with Re-check now on Settings, Token vault.`;
}
