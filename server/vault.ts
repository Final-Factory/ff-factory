import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkObject, readJsonDurable } from './durable.ts';
import { withFileLock, writeJsonOwned } from './machineTokens.ts';
import type { PlanUsage, VaultEntryMeta, VaultKind, VaultRole, VaultShare, VaultStatus, WorkItem } from '../shared/types.ts';
import { POOL_DEFAULTS, pickPool, judge, type PoolLimits, type PoolToken, type PoolView } from './tokenPool.ts';

/**
 * The token vault (docs/vault.md, w512): the secrets worker runs need, kept by the portal, encrypted value by value with a
 * key that lives outside the data folder, and handed to each run as environment variables in its launch spec. A value is
 * never shown back: everything that lists the vault shows a fingerprint and the last four characters.
 */

export type { VaultEntryMeta, VaultKind, VaultRole, VaultShare, VaultStatus } from '../shared/types.ts';
export const VAULT_KINDS: readonly VaultKind[] = ['claude', 'github', 'env'];
export const VAULT_ROLES: readonly VaultRole[] = ['workers', 'standing'];

interface Sealed {
  iv: string;
  tag: string;
  ct: string;
}

interface VaultEntry extends VaultEntryMeta {
  sealed: Sealed;
  /** Which key sealed it (a hash prefix of the key): after a new key, the entries sealed with the old one are named, and rotating one re-seals it. */
  keyId: string;
}

interface VaultFile {
  version: 1;
  entries: VaultEntry[];
}

/** The systemd credential the portal's unit loads (deploy/vm/guest/units/fff-portal.service, LoadCredential). */
export const VAULT_CREDENTIAL = 'fff-vault-key';
export const VAULT_FILE = 'vault.json';

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const MACHINE = /^[a-z0-9][a-z0-9-]*$/;
const OAUTH = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/;
const GITHUB = /^(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const ENV_SUFFIX = /_(?:TOKEN|KEY|SECRET|PASSWORD)$/;
const ENV_RESERVED = /^(?:CLAUDE_|ANTHROPIC_|GH_|GITHUB_|GIT_)/;
/** How long a pick counts as live before the session's process shows in the live counts (a start in progress). */
const PENDING_MS = 20_000;

export const fingerprintOf = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const keyIdOf = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

/** Why `value` cannot be an entry of `kind` (never quoting it), or undefined. */
export function valueProblem(kind: VaultKind, value: string): string | undefined {
  if (!value) return 'the value is empty';
  if (/\s/.test(value)) return 'the value holds whitespace (put it alone in the file, on one line)';
  if (kind === 'claude' && !OAUTH.test(value)) return 'not a Claude OAuth token (one sk-ant-oat01-… token from `claude setup-token`)';
  if (kind === 'github' && !GITHUB.test(value)) return 'not a GitHub token (ghp_, gho_, ghu_, ghs_, ghr_ or github_pat_…)';
  if (kind === 'env' && (value.length < 8 || value.length > 4096)) return 'a secret is 8 to 4096 characters';
  return undefined;
}

/** Why `name` cannot be a kind-env variable (docs/vault.md, section 2), or undefined. */
/** Why `email` cannot be recorded for a Claude token, or undefined: one plain address, no spaces, at most 120 characters (w785). */
export function emailProblem(email: string): string | undefined {
  const e = email.trim();
  return e.length <= 120 && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(e) ? undefined : 'email is one address like name@example.com (no spaces, at most 120 characters)';
}

export function envNameProblem(name: string | undefined): string | undefined {
  if (!name || !ENV_NAME.test(name)) return 'the variable name is upper-case letters, digits and underscores, e.g. FFDISCORD_APP_TOKEN';
  if (!ENV_SUFFIX.test(name)) return `${name}: a vault variable ends in _TOKEN, _KEY, _SECRET or _PASSWORD`;
  if (ENV_RESERVED.test(name)) return `${name}: CLAUDE_, ANTHROPIC_, GH_, GITHUB_ and GIT_ variables are not kind env (use kind claude or github)`;
  return undefined;
}

// ---------------------------------------------------------------- whose tokens (docs/vault.md, "Whose tokens")

/** Kinds of work nobody asked for by name (config vault.unattributed). */
export type UnattributedKind = 'intake' | 'ffbox' | 'nightly';
/**
 * lothsahn, 2026-10-06: "Intake should be my token. Nightly sentry Ben. Ffbox me unless it provides an operator... In that
 * case, use the token of the operator." (An FFBox request naming an operator is that person's own: not unattributed.)
 */
export const UNATTRIBUTED_DEFAULTS: Readonly<Record<UnattributedKind, string>> = { intake: 'lothsahn', ffbox: 'lothsahn', nightly: 'ben' };
/** The nightly regression sentry's standing agent id (server/schedule.ts AUTO_BY_DEFAULT). */
export const NIGHTLY_SENTRY = 'nightly-regression-sentry';

/** Which kind of nobody's work a request is, or undefined when a person asked for it. */
export function unattributedKind(w: Pick<WorkItem, 'source' | 'delegation' | 'unattributed'>): UnattributedKind | undefined {
  if (w.delegation?.agentId === NIGHTLY_SENTRY) return 'nightly';
  if (!w.unattributed || !w.source) return undefined;
  const k = w.source.kind;
  return k === 'nightly' || k === 'nightly-run' || k === 'nightly-review' ? 'nightly' : k.startsWith('ffbox-') ? 'ffbox' : 'intake';
}

/** The user id whose vault tokens a kind of nobody's work runs on: config vault.unattributed, else the defaults. */
export const unattributedPerson = (cfg: { vault?: { unattributed?: Partial<Record<UnattributedKind, string>> } }, kind: UnattributedKind) =>
  cfg.vault?.unattributed?.[kind] ?? UNATTRIBUTED_DEFAULTS[kind];

/**
 * Whose tokens a worker serving `w` gets (w512): the configured person for work nobody asked for by name, else undefined
 * (the run's own person: its requester, which for a request is whoever filed it).
 */
export function tokenPersonForWork(cfg: { vault?: { unattributed?: Partial<Record<UnattributedKind, string>> } }, w: Pick<WorkItem, 'source' | 'delegation' | 'unattributed'> | undefined): string | undefined {
  const kind = w ? unattributedKind(w) : undefined;
  return kind ? unattributedPerson(cfg, kind) : undefined;
}

// ---------------------------------------------------------------- the key

export interface KeySource {
  /** Where the key is read from, or why there is none. */
  file?: string;
  why?: string;
  /** Set when `file` is the systemd credential: the credentials folder it is in (readKey's credential rule applies to it alone). */
  credentialsDir?: string;
}

/**
 * Where the vault key is: the systemd credential (in the VM, `$CREDENTIALS_DIRECTORY/fff-vault-key`), else config
 * vault.keyFile. A key file inside the data folder is refused: the point is that a copy of data/ holds no key.
 */
export function keySource(cfg: { dataDir: string; vault?: { keyFile?: string } }, env: NodeJS.ProcessEnv = process.env): KeySource {
  const cred = env.CREDENTIALS_DIRECTORY ? path.join(env.CREDENTIALS_DIRECTORY, VAULT_CREDENTIAL) : undefined;
  const fromCredential = !!cred && fs.existsSync(cred);
  const file = fromCredential ? cred : cfg.vault?.keyFile;
  if (!file) return { why: `no vault key: neither the systemd credential ${VAULT_CREDENTIAL} nor config vault.keyFile` };
  const rel = path.relative(path.resolve(cfg.dataDir), path.resolve(file));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { why: `the vault key ${file} is inside the data folder; keep it outside (docs/vault.md)` };
  return { file, ...(fromCredential ? { credentialsDir: env.CREDENTIALS_DIRECTORY } : {}) };
}

export interface ReadKeyOptions {
  platform?: NodeJS.Platform;
  /** The systemd credentials folder, when `file` is the credential in it (KeySource.credentialsDir). */
  credentialsDir?: string;
  /** The accounts that may own a credential: root and this process's own (tests set it). */
  owners?: number[];
}

/**
 * Why a systemd credential file is not private enough, or undefined when it is. systemd (exec-credential.c write_credential)
 * writes it 0400, root-owned, and gives the service user read access by a POSIX ACL entry; stat then reports the ACL's
 * mask in the group bits, so a file only the service user can read shows as 0440 (measured on Ubuntu with systemd 255:
 * `setfacl -m u:nobody:r` on a 0400 root file gives mode 440, owner 0:0, `group::---`). Where the file system has no ACLs
 * systemd chowns the file to the service user instead (0400). So in the credentials folder the group bits are not a
 * grant to a group; "other" must be empty, nobody but root or this account may own the file, and no write bit may be set.
 * The folder itself must be closed to others too. Anywhere else the strict rule applies (readKey).
 */
function credentialProblem(file: string, st: fs.Stats, dir: string, owners: number[]): string | undefined {
  let real: string;
  let realDir: string;
  try {
    real = fs.realpathSync(file);
    realDir = fs.realpathSync(dir);
  } catch {
    return 'it cannot be resolved';
  }
  if (path.dirname(real) !== realDir) return 'it is not directly in the credentials folder';
  if (!st.isFile()) return 'it is not a regular file';
  if (st.mode & 0o007) return `other users can access it (mode ${(st.mode & 0o777).toString(8)})`;
  if (st.mode & 0o022) return `it is writable by a group or others (mode ${(st.mode & 0o777).toString(8)})`;
  if (!owners.includes(st.uid)) return `it is owned by uid ${st.uid}`;
  const d = fs.statSync(realDir);
  if (d.mode & 0o007) return `its folder is open to other users (mode ${(d.mode & 0o777).toString(8)})`;
  if (!owners.includes(d.uid)) return `its folder is owned by uid ${d.uid}`;
  return undefined;
}

/**
 * The 32-byte key in `file` (base64), checked: never shown, and refused when other users may read it (POSIX): no group or
 * other bits at all, except for systemd's own credential file in its credentials folder (credentialProblem).
 */
export function readKey(file: string, o: ReadKeyOptions = {}): Buffer {
  const platform = o.platform ?? process.platform;
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (e) {
    throw new Error(`cannot read the vault key ${file}: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`);
  }
  if (platform !== 'win32' && st.mode & 0o077) {
    const bad = o.credentialsDir ? credentialProblem(file, st, o.credentialsDir, o.owners ?? [0, process.getuid?.() ?? 0]) : undefined;
    if (o.credentialsDir && bad === undefined) {
      // systemd's credential: private to the unit (ACL mask in the group bits), nothing to fix.
    } else {
      throw new Error(`the vault key ${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)})${bad ? `: ${bad}` : ''}; chmod 600 it`);
    }
  }
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`the vault key ${file} is not 32 bytes of base64 (fffctl vault init makes one); its content is not shown`);
  return key;
}

/** A new key, as the text of a key file. */
export const newKeyText = () => `${randomBytes(32).toString('base64')}\n`;

const aad = (e: Pick<VaultEntryMeta, 'id' | 'kind'>) => Buffer.from(`ffvault1|${e.id}|${e.kind}`);

function seal(key: Buffer, e: Pick<VaultEntryMeta, 'id' | 'kind'>, value: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(e));
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function unseal(key: Buffer, e: VaultEntry): string {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.sealed.iv, 'base64'));
  d.setAAD(aad(e));
  d.setAuthTag(Buffer.from(e.sealed.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.sealed.ct, 'base64')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- choosing a Claude token

/**
 * The kinds of run the vault serves: a worker or a standing agent on a machine, the ops worker for a person, and a
 * person's own orchestrator on the portal. The last two take no machine grant; the orchestrator takes no role grant.
 */
export type RunRole = VaultRole | 'orchestrator' | 'ops';

/** A run, as the vault needs it. */
export interface VaultRun {
  machineId: string;
  role: RunRole;
  /** The person the run is for (its requester, else the system payer). */
  userId?: string;
  sessionId?: string;
}

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Whether `e` may serve `run` at all (enabled and granted to the run's role and machine). A Claude token serves only
 * its owner's runs (w739: a person's pool, no shared Claude token and no one else's); every other kind is the run's
 * person's own or shared. The ops worker takes the workers' grants; a person's orchestrator takes none: the account
 * setting claudeAccounts.orchestrator is its consent.
 */
export function eligible(e: VaultEntryMeta, run: VaultRun): boolean {
  if (e.disabled) return false;
  if (run.role !== 'orchestrator') {
    if (!e.roles.includes(run.role === 'ops' ? 'workers' : run.role)) return false;
    if (run.role !== 'ops' && !e.machines.includes('*') && !e.machines.some((m) => same(m, run.machineId))) return false;
  }
  if (e.kind === 'claude') return same(e.owner, run.userId);
  return e.share === 'anyone' || same(e.owner, run.userId);
}

/**
 * A run that may not start now because its person's Claude pool has no token that may serve it (every one over its caps or
 * used up): a worker or the ops worker waits (queued with this reason), an orchestrator stops. `next` is when the first
 * token frees up (ISO). Never holds a token's value.
 */
export class PoolHeldError extends Error {
  readonly next?: string;
  constructor(message: string, next?: string) {
    super(message);
    this.name = 'PoolHeldError';
    this.next = next;
  }
}

/** The limits a pick applies, read when it is made; the defaults without a context (tests). */
export type PoolLimitsOf = () => PoolLimits;

// ---------------------------------------------------------------- the store

export interface AddInput {
  name: string;
  kind: VaultKind;
  value: string;
  env?: string;
  owner?: string;
  /** kind claude only: the account's email, as a person recorded it (w785). */
  email?: string;
  share?: VaultShare;
  roles?: VaultRole[];
  machines?: string[];
}

export type UpdateInput = Partial<Pick<VaultEntryMeta, 'owner' | 'share' | 'roles' | 'machines' | 'disabled' | 'email'>>;

/** What a run gets from the vault: one Claude token (with its entry) and the other granted secrets, as environment. */
export interface RunSecrets {
  claude?: { entry: VaultEntryMeta; token: string; how: 'normal' | 'over-cap' };
  /**
   * The run's person has Claude tokens in the vault and none may serve this run now (every one over its caps or used up):
   * the run is held (a worker, the ops worker) or stopped (an orchestrator), with this reason and when the first frees up.
   */
  claudeHold?: { why: string; next?: string };
  /** How many Claude tokens the run's person has (enabled, granted to the run): 0 is the transition, today's account. */
  poolSize?: number;
  /** With `github`: the GitHub entry given as GH_TOKEN (w868), never its value. */
  github?: VaultEntryMeta;
  env: Record<string, string>;
  /** Entries granted to the run that could not be opened (no key, a wrong key): named, never their values. */
  problems: string[];
}

export interface VaultOptions {
  /** data/vault.json */
  file: string;
  /** Where the key is, asked at each use (a key loaded or replaced later applies without a restart). */
  key: () => KeySource;
  /** Every value the vault holds, whenever they change: redaction learns them (server/secrets.ts registerSecretValues). */
  onValues?: (values: string[]) => void;
  /** Root writing for the portal's user (fffctl): the files are given to the data folder's owner. */
  chownLike?: string;
  now?: () => Date;
}

/** Shape-check of a vault file: entries with the fields the code reads. */
function checkVault(v: unknown): string | undefined {
  const c = checkObject(v);
  if (c) return c;
  const f = v as Partial<VaultFile>;
  if (f.version !== 1 || !Array.isArray(f.entries)) return 'not a version 1 vault';
  for (const e of f.entries) if (!e || typeof e.id !== 'string' || typeof e.name !== 'string' || !VAULT_KINDS.includes(e.kind) || !e.sealed || typeof e.keyId !== 'string') return 'an entry is malformed';
  return undefined;
}

export class Vault {
  private readonly o: VaultOptions;
  private data: VaultFile = { version: 1, entries: [] };
  private mtime = -1;
  /** session id → the Claude entry it ran on last (pickClaude's sticky). */
  private readonly lastPick = new Map<string, string>();
  /** token fingerprint → session id → when it was picked: a process not yet in the live counts (PENDING_MS). */
  private readonly recent = new Map<string, Map<string, number>>();

  constructor(o: VaultOptions) {
    this.o = o;
    this.reload();
  }

  private now() {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  /** Read the file again if it changed on disk (fffctl edits it while the portal runs). */
  private reload() {
    let m = 0;
    try {
      m = fs.statSync(this.o.file).mtimeMs;
    } catch {
      m = 0;
    }
    if (m === this.mtime) return;
    this.mtime = m;
    this.data = (m ? readJsonDurable<VaultFile>(this.o.file, { check: checkVault, generations: 0, mode: 0o600 }) : undefined) ?? { version: 1, entries: [] };
    this.publishValues();
  }

  private key(): { key?: Buffer; status: Omit<VaultStatus, 'entries'> } {
    const src = this.o.key();
    if (!src.file) return { status: { key: 'missing', why: src.why } };
    let key: Buffer;
    try {
      key = readKey(src.file, { credentialsDir: src.credentialsDir });
    } catch (e) {
      return { status: { key: 'unreadable', why: (e as Error).message, keyFile: src.file } };
    }
    const id = keyIdOf(key);
    const stale = this.data.entries.filter((e) => e.keyId !== id).map((e) => e.name);
    if (stale.length && stale.length === this.data.entries.length) return { key, status: { key: 'wrong', why: `the vault key ${src.file} sealed none of the entries; rotate each one (${stale.join(', ')}) or put the old key back`, keyFile: src.file } };
    return { key, status: { key: 'loaded', keyFile: src.file, ...(stale.length ? { why: `sealed with another key, rotate: ${stale.join(', ')}` } : {}) } };
  }

  status(): VaultStatus {
    this.reload();
    return { ...this.key().status, entries: this.data.entries.length };
  }

  list(): VaultEntryMeta[] {
    this.reload();
    return this.data.entries.map((e) => this.meta(e));
  }

  private meta(e: VaultEntry): VaultEntryMeta {
    const { sealed: _s, keyId: _k, ...meta } = e;
    return { ...meta, roles: [...meta.roles], machines: [...meta.machines] };
  }

  private find(name: string): VaultEntry {
    const e = this.data.entries.find((x) => x.name === name);
    if (!e) throw new Error(`no vault entry named ${name}`);
    return e;
  }

  private byId(id: string): VaultEntry | undefined {
    return this.data.entries.find((x) => x.id === id);
  }

  /** Lock, re-read, change, write: fffctl and the portal may both write. */
  private change<T>(fn: (key: Buffer | undefined) => T, needKey: boolean): T {
    return withFileLock(this.o.file, () => {
      this.mtime = -1;
      this.reload();
      const k = this.key();
      if (needKey && !k.key) throw new Error(`the vault cannot seal values: ${k.status.why}`);
      const out = fn(k.key);
      // No old generations: a removed or rotated value leaves no copy behind.
      writeJsonOwned(this.o.file, this.data, this.o.chownLike, 0);
      this.mtime = fs.statSync(this.o.file).mtimeMs;
      this.publishValues();
      return out;
    });
  }

  private checkGrant(i: UpdateInput & { kind: VaultKind }) {
    if (i.email !== undefined && i.email !== '') {
      if (i.kind !== 'claude') throw new Error('an email is only for a Claude token (the account it belongs to)');
      const why = emailProblem(i.email);
      if (why) throw new Error(why);
    }
    if (i.share !== undefined && i.share !== 'owner' && i.share !== 'anyone') throw new Error('share is "owner" (the owner\'s own work only) or "anyone"');
    if (i.roles !== undefined && (!i.roles.length || i.roles.some((r) => !VAULT_ROLES.includes(r)))) throw new Error(`roles are one or more of ${VAULT_ROLES.join(', ')}`);
    if (i.machines !== undefined && (!i.machines.length || i.machines.some((m) => m !== '*' && !MACHINE.test(m)))) throw new Error('machines are machine ids (lower-case letters, digits, dashes) or "*" for every machine');
    if (i.owner !== undefined && i.owner !== '' && !/^[A-Za-z0-9._-]{1,64}$/.test(i.owner)) throw new Error('owner is a portal user id');
  }

  add(i: AddInput): VaultEntryMeta {
    if (!NAME.test(i.name)) throw new Error('a name is lower-case letters, digits, ".", "_" and "-", up to 40, e.g. ben-max');
    if (!VAULT_KINDS.includes(i.kind)) throw new Error(`kind is one of ${VAULT_KINDS.join(', ')}`);
    const bad = valueProblem(i.kind, i.value);
    if (bad) throw new Error(bad);
    if (i.kind === 'env') {
      const why = envNameProblem(i.env);
      if (why) throw new Error(why);
    } else if (i.env) throw new Error('env is only for kind env');
    const share = i.share ?? 'owner';
    const grant = { kind: i.kind, share, owner: i.owner, ...(i.email ? { email: i.email.trim() } : {}), roles: i.roles ?? ['workers', 'standing'], machines: (i.machines ?? ['*']).map((m) => m.toLowerCase()) };
    this.checkGrant(grant);
    if (share === 'owner' && !i.owner) throw new Error('an entry for its owner\'s own work needs --owner (a portal user id), or share it with "anyone"');
    return this.change((key) => {
      if (this.data.entries.some((e) => e.name === i.name)) throw new Error(`a vault entry named ${i.name} exists; rotate it instead`);
      const fp = fingerprintOf(i.value);
      const dup = this.data.entries.find((e) => e.fingerprint === fp);
      if (dup) throw new Error(`that value is already in the vault as ${dup.name}`);
      const at = this.now();
      const meta: VaultEntryMeta = { id: randomBytes(4).toString('hex'), name: i.name, kind: i.kind, ...(i.env ? { env: i.env } : {}), ...(i.owner ? { owner: i.owner } : {}), ...(grant.email ? { email: grant.email } : {}), share, roles: grant.roles, machines: grant.machines, fingerprint: fp, last4: i.value.slice(-4), createdAt: at, updatedAt: at };
      this.data.entries.push({ ...meta, sealed: seal(key!, meta, i.value), keyId: keyIdOf(key!) });
      return meta;
    }, true);
  }

  rotate(name: string, value: string): VaultEntryMeta {
    return this.change((key) => {
      const e = this.find(name);
      const bad = valueProblem(e.kind, value);
      if (bad) throw new Error(bad);
      const fp = fingerprintOf(value);
      const dup = this.data.entries.find((x) => x.fingerprint === fp && x.id !== e.id);
      if (dup) throw new Error(`that value is already in the vault as ${dup.name}`);
      const at = this.now();
      Object.assign(e, { fingerprint: fp, last4: value.slice(-4), rotatedAt: at, updatedAt: at, sealed: seal(key!, e, value), keyId: keyIdOf(key!) });
      return this.meta(e);
    }, true);
  }

  update(name: string, patch: UpdateInput): VaultEntryMeta {
    return this.change(() => {
      const e = this.find(name);
      const p = { ...patch, ...(patch.machines ? { machines: patch.machines.map((m) => m.toLowerCase()) } : {}) };
      this.checkGrant({ ...p, kind: e.kind });
      const next = { ...e, ...p };
      if (next.owner === '') delete next.owner;
      if (typeof next.email === 'string') next.email = next.email.trim();
      if (!next.email) delete next.email;
      if (next.share === 'owner' && !next.owner) throw new Error('an entry for its owner\'s own work needs an owner');
      Object.assign(e, next, { updatedAt: this.now() });
      if (!next.owner) delete e.owner;
      if (!next.email) delete e.email;
      if (!next.disabled) delete e.disabled;
      return this.meta(e);
    }, false);
  }

  /**
   * The same entry under another name (w748: host-ben-claude-1 became vault-ben-1). Its id, value, grants and fingerprint
   * stay, so the person's pool, the usage meters and the sessions' last pick carry over; only the name changes.
   */
  rename(from: string, to: string): VaultEntryMeta {
    if (!NAME.test(to)) throw new Error('a name is lower-case letters, digits, ".", "_" and "-", up to 40, e.g. vault-ben-1');
    return this.change(() => {
      const e = this.find(from);
      if (from !== to && this.data.entries.some((x) => x.name === to)) throw new Error(`a vault entry named ${to} exists`);
      Object.assign(e, { name: to, updatedAt: this.now() });
      return this.meta(e);
    }, false);
  }

  remove(name: string): VaultEntryMeta {
    return this.change(() => {
      const e = this.find(name);
      this.data.entries = this.data.entries.filter((x) => x.id !== e.id);
      for (const [s, id] of this.lastPick) if (id === e.id) this.lastPick.delete(s);
      return this.meta(e);
    }, false);
  }

  /**
   * One entry's value. Besides a run's own environment, `fffctl vault export` (root, in the VM) is the only way out of the
   * vault, for the FFBox host's nightly copy (docs/vault.md, section 12). No route, tool or listing calls it.
   */
  reveal(name: string): string {
    this.reload();
    const e = this.find(name);
    const { key } = this.key();
    const value = key ? this.open(key, e) : undefined;
    if (value === undefined) throw new Error(`${name} cannot be opened with the vault key (rotate it, or put the right key back)`);
    return value;
  }

  private open(key: Buffer, e: VaultEntry): string | undefined {
    try {
      return unseal(key, e);
    } catch {
      return undefined;
    }
  }

  /** Tell redaction every value (on each load and change); a vault with no key teaches nothing. */
  private publishValues() {
    if (!this.o.onValues) return;
    const { key } = this.key();
    this.o.onValues(key ? this.data.entries.map((e) => this.open(key, e)).filter((v): v is string => !!v) : []);
  }

  /** The Claude tokens the usage meters poll: every enabled claude entry the key opens, labelled by name. */
  claudeTokens(): { token: string; label: string; fingerprint: string; email?: string }[] {
    this.reload();
    const { key } = this.key();
    if (!key) return [];
    return this.data.entries
      .filter((e) => e.kind === 'claude' && !e.disabled)
      .map((e) => ({ e, token: this.open(key, e) }))
      .filter((x): x is { e: VaultEntry; token: string } => !!x.token)
      .map(({ e, token }) => ({ token, label: `${e.name} …${e.last4}`, fingerprint: e.fingerprint, ...(e.email ? { email: e.email } : {}) }));
  }

  /** Every enabled GitHub entry the key opens, with its value: the health probe's list (server/githubTokens.ts, w868). */
  githubTokens(): { entry: VaultEntryMeta; token: string }[] {
    this.reload();
    const { key } = this.key();
    if (!key) return [];
    return this.data.entries
      .filter((e) => e.kind === 'github' && !e.disabled)
      .map((e) => ({ entry: this.meta(e), token: this.open(key, e) }))
      .filter((x): x is { entry: VaultEntryMeta; token: string } => !!x.token);
  }

  /**
   * The GitHub token the portal's own reads use for a person's work (w868): their own entry first, then one shared with
   * anyone, by name; none known to be refused or expired. The portal is not a machine, so no role or machine grant applies:
   * machines.githubFromVault's "portal" is the consent.
   */
  githubFor(person: string | undefined, usable: (fingerprint: string) => boolean = () => true): { entry: VaultEntryMeta; token: string } | undefined {
    const run: VaultRun = { machineId: 'portal', role: 'orchestrator', userId: person };
    const order = (e: VaultEntryMeta) => `${same(e.owner, person) ? 0 : 1}${e.name}`;
    return this.githubTokens()
      .filter((x) => eligible(x.entry, run) && usable(x.entry.fingerprint))
      .sort((a, b) => order(a.entry).localeCompare(order(b.entry)))[0];
  }

  /** The pick's view of one Claude entry: its meters, and the processes live on it other than `except`'s. */
  private poolToken(e: VaultEntry, usageOf: ((fp: string) => PlanUsage | undefined) | undefined, liveOn: ((fp: string, except?: string) => number) | undefined, except: string | undefined, now: number): PoolToken {
    const r = this.recent.get(e.fingerprint);
    let pending = 0;
    if (r) {
      for (const [sid, at] of r) {
        if (now - at > PENDING_MS) r.delete(sid);
        else if (sid !== except) pending++;
      }
    }
    // A start in progress is not in the live counts yet; whichever is more, never both (the same process).
    return { id: e.id, name: e.name, fingerprint: e.fingerprint, owner: e.owner, usage: usageOf?.(e.fingerprint), others: Math.max(liveOn?.(e.fingerprint, except) ?? 0, pending) };
  }

  /**
   * Every person's Claude pool as the rules read it now (system_status, `fffctl vault list`): each enabled token with its
   * state and how many processes run on it. The state is the worker's reading (the strictest).
   */
  pools(o: { usageOf?: (fp: string) => PlanUsage | undefined; liveOn?: (fp: string, except?: string) => number; limits?: PoolLimitsOf; now?: () => number }): Map<string, { entry: VaultEntryMeta; view: PoolView; live: number }[]> {
    this.reload();
    const limits = o.limits?.() ?? POOL_DEFAULTS;
    const now = o.now?.() ?? Date.now();
    const out = new Map<string, { entry: VaultEntryMeta; view: PoolView; live: number }[]>();
    for (const e of this.data.entries) {
      if (e.kind !== 'claude' || e.disabled || !e.owner) continue;
      const t = this.poolToken(e, o.usageOf, o.liveOn, undefined, now);
      const list = out.get(e.owner.toLowerCase()) ?? [];
      list.push({ entry: this.meta(e), view: judge(t, limits), live: t.others });
      out.set(e.owner.toLowerCase(), list);
    }
    return out;
  }

  /** The fingerprint of the Claude entry a session ran on last (this portal run), for attributing its stopped session. */
  lastPickOf(sessionId: string): string | undefined {
    const id = this.lastPick.get(sessionId);
    return id ? this.byId(id)?.fingerprint : undefined;
  }

  /**
   * What a run gets (docs/vault.md, section 3): with `claude`, one Claude token chosen by the pool rules (tokenPool.ts); and every other
   * entry granted to the run's role and machine, as environment. Nothing when the key is missing (the problems say so).
   */
  forRun(run: VaultRun, o: { claude: boolean; github?: boolean; githubUsable?: (fingerprint: string) => boolean; usageOf?: (fingerprint: string) => PlanUsage | undefined; liveOn?: (fingerprint: string, exceptSession?: string) => number; limits?: PoolLimitsOf; now?: () => number }): RunSecrets {
    this.reload();
    const out: RunSecrets = { env: {}, problems: [] };
    // GitHub entries only where machines.githubFromVault is on (w868), and none known to be refused or expired.
    const granted = this.data.entries.filter((e) => eligible(e, run) && (e.kind !== 'github' || (!!o.github && (o.githubUsable?.(e.fingerprint) ?? true))));
    const wanted = granted.filter((e) => e.kind !== 'claude' || o.claude);
    if (!wanted.length) return out;
    const { key, status } = this.key();
    if (!key) {
      out.problems.push(`the vault cannot open ${wanted.map((e) => e.name).join(', ')}: ${status.why}`);
      return out;
    }
    // One value per variable: the run's person's own entry first, then by name (two entries giving GH_TOKEN never race).
    const order = (e: VaultEntryMeta) => `${same(e.owner, run.userId) ? 0 : 1}${e.name}`;
    for (const e of [...granted].sort((a, b) => order(a).localeCompare(order(b)))) {
      if (e.kind === 'claude') continue;
      const name = e.kind === 'github' ? 'GH_TOKEN' : e.env;
      if (!name || name in out.env) continue;
      const v = this.open(key, e);
      if (!v) {
        out.problems.push(`vault entry ${e.name} does not open with this key (rotate it)`);
        continue;
      }
      out.env[name] = v;
      if (e.kind === 'github') out.github = this.meta(e);
    }
    if (o.claude) {
      const sticky = run.sessionId ? this.lastPick.get(run.sessionId) : undefined;
      const limits = o.limits?.() ?? POOL_DEFAULTS;
      const now = o.now?.() ?? Date.now();
      const tried = new Set<string>();
      out.poolSize = granted.filter((e) => e.kind === 'claude').length;
      // A token that does not open (sealed by another key) is skipped for the next best.
      for (;;) {
        const tokens = granted.filter((e) => e.kind === 'claude' && !tried.has(e.id)).map((e) => this.poolToken(e, o.usageOf, o.liveOn, run.sessionId, now));
        if (!tokens.length) break;
        const pick = pickPool(tokens, { orchestrator: run.role === 'orchestrator', limits, sticky });
        if (!pick.token) {
          out.claudeHold = pick.held;
          break;
        }
        const e = this.byId(pick.token.id)!;
        const v = this.open(key, e);
        if (v) {
          if (run.sessionId) {
            this.lastPick.delete(run.sessionId);
            this.lastPick.set(run.sessionId, e.id);
            // Oldest first: a portal that runs for months keeps the last few thousand sessions' picks only.
            if (this.lastPick.size > 5000) this.lastPick.delete(this.lastPick.keys().next().value!);
            const r = this.recent.get(e.fingerprint) ?? new Map<string, number>();
            r.set(run.sessionId, now);
            this.recent.set(e.fingerprint, r);
          }
          out.claude = { entry: this.meta(e), token: v, how: pick.how ?? 'normal' };
          break;
        }
        tried.add(pick.token.id);
        out.problems.push(`vault entry ${pick.token.name} does not open with this key (rotate it)`);
      }
    }
    return out;
  }
}

/**
 * The portal's vault and what choosing a token needs, set once by server/index.ts: the usage meters' numbers per token
 * (`usageOf`, by fingerprint), how many live sessions run on each (`liveOn`), and the system payer's user id for runs
 * nobody asked for (`payer`). Unset (tests, the daemon), machineRunEnv gives what it gave before the vault.
 */
export interface VaultContext {
  vault: Vault;
  usageOf?: (fingerprint: string) => PlanUsage | undefined;
  /** Live processes on a token, not counting `exceptSession`'s own. */
  liveOn?: (fingerprint: string, exceptSession?: string) => number;
  /** The system-wide pool limits in effect (config vault.pool), read at each pick. */
  limits?: PoolLimitsOf;
  payer?: () => string | undefined;
  /** A run that wanted a vault Claude token and fell back, or an entry that would not open: for the log and system_status. */
  onProblem?: (line: string) => void;
  /** Whether a GitHub token may be handed out (not refused by GitHub, not expired: server/githubTokens.ts, w868). */
  githubUsable?: (fingerprint: string) => boolean;
  /** A GitHub entry was given to a run: its last use on the vault page. */
  onGithubUse?: (entry: VaultEntryMeta, what: string) => void;
}
let context: VaultContext | undefined;
export const setVaultContext = (c: VaultContext | undefined) => {
  context = c;
};
export const vaultContext = () => context;

/** One line for system_status: how many entries, whether the key is loaded. Never a value. */
export function vaultStatusLine(v: Vault | undefined, claudeMachines: string[]): string | undefined {
  if (!v) return undefined;
  const s = v.status();
  if (!s.entries && s.key === 'missing' && !claudeMachines.length) return undefined;
  const list = v.list();
  const kinds = VAULT_KINDS.map((k) => [k, list.filter((e) => e.kind === k).length] as const).filter(([, n]) => n);
  return `Token vault (docs/vault.md): ${s.entries} entr${s.entries === 1 ? 'y' : 'ies'}${kinds.length ? ` (${kinds.map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}; key ${s.key}${s.why ? ` (${s.why})` : ''}; Claude tokens from it on ${claudeMachines.length ? claudeMachines.join(', ') : 'no machine yet (machines.claudeFromVault)'}`;
}
