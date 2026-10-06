import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';
import type { PlanUsage, VaultEntryMeta, VaultKind, VaultRole, VaultShare, VaultStatus } from '../shared/types.ts';

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
}

interface VaultFile {
  version: 1;
  /** Which key sealed the entries (a hash prefix of it), so a wrong key reads as wrong, not as damaged entries. */
  keyId?: string;
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
/** A meter at this percent or more counts as out of room (section 4 of docs/vault.md). */
export const FULL_PERCENT = 95;
/** The headroom assumed for a token with no numbers yet. */
const UNKNOWN_HEADROOM = 50;

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
export function envNameProblem(name: string | undefined): string | undefined {
  if (!name || !ENV_NAME.test(name)) return 'the variable name is upper-case letters, digits and underscores, e.g. FFDISCORD_APP_TOKEN';
  if (!ENV_SUFFIX.test(name)) return `${name}: a vault variable ends in _TOKEN, _KEY, _SECRET or _PASSWORD`;
  if (ENV_RESERVED.test(name)) return `${name}: CLAUDE_, ANTHROPIC_, GH_, GITHUB_ and GIT_ variables are not kind env (use kind claude or github)`;
  return undefined;
}

// ---------------------------------------------------------------- the key

export interface KeySource {
  /** Where the key is read from, or why there is none. */
  file?: string;
  why?: string;
}

/**
 * Where the vault key is: the systemd credential (in the VM, `$CREDENTIALS_DIRECTORY/fff-vault-key`), else config
 * vault.keyFile. A key file inside the data folder is refused: the point is that a copy of data/ holds no key.
 */
export function keySource(cfg: { dataDir: string; vault?: { keyFile?: string } }, env: NodeJS.ProcessEnv = process.env): KeySource {
  const cred = env.CREDENTIALS_DIRECTORY ? path.join(env.CREDENTIALS_DIRECTORY, VAULT_CREDENTIAL) : undefined;
  const file = cred && fs.existsSync(cred) ? cred : cfg.vault?.keyFile;
  if (!file) return { why: `no vault key: neither the systemd credential ${VAULT_CREDENTIAL} nor config vault.keyFile` };
  const rel = path.relative(path.resolve(cfg.dataDir), path.resolve(file));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { why: `the vault key ${file} is inside the data folder; keep it outside (docs/vault.md)` };
  return { file };
}

/** The 32-byte key in `file` (base64), checked: never shown, and refused when other users may read it (POSIX). */
export function readKey(file: string, platform: NodeJS.Platform = process.platform): Buffer {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (e) {
    throw new Error(`cannot read the vault key ${file}: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`);
  }
  if (platform !== 'win32' && st.mode & 0o077) throw new Error(`the vault key ${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
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

/** A run on a machine, as the vault needs it. */
export interface VaultRun {
  machineId: string;
  role: VaultRole;
  /** The person the run is for (its requester, else the system payer). */
  userId?: string;
  sessionId?: string;
}

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Whether `e` may serve `run` at all (enabled, granted to its role and machine, shared or the run's person's own). */
export function eligible(e: VaultEntryMeta, run: VaultRun): boolean {
  if (e.disabled) return false;
  if (!e.roles.includes(run.role)) return false;
  if (!e.machines.includes('*') && !e.machines.some((m) => same(m, run.machineId))) return false;
  return e.share === 'anyone' || same(e.owner, run.userId);
}

/** How much room a token's account has left: 100 minus its fullest 5-hour or weekly meter, or undefined when unknown. */
export function headroom(u: PlanUsage | undefined): number | undefined {
  if (!u?.available) return undefined;
  const used = [u.session?.percent, u.weekly?.percent].filter((p): p is number => typeof p === 'number');
  return used.length ? 100 - Math.max(...used) : undefined;
}

/**
 * The Claude entry a run gets (docs/vault.md, section 4): among the eligible ones, the run's person's own first, then
 * those with room (under FULL_PERCENT on both meters), the most headroom, the fewest live sessions, the name. `sticky`:
 * the entry the session ran on last, kept while it is eligible and has room.
 */
export function pickClaude(
  entries: readonly VaultEntryMeta[],
  run: VaultRun,
  usageOf: (fingerprint: string) => PlanUsage | undefined = () => undefined,
  liveOn: (fingerprint: string) => number = () => 0,
  sticky?: string,
): VaultEntryMeta | undefined {
  const pool = entries.filter((e) => e.kind === 'claude' && eligible(e, run));
  const room = (e: VaultEntryMeta) => headroom(usageOf(e.fingerprint));
  const full = (e: VaultEntryMeta) => {
    const h = room(e);
    return h !== undefined && h <= 100 - FULL_PERCENT;
  };
  const kept = sticky ? pool.find((e) => e.id === sticky) : undefined;
  if (kept && !full(kept)) return kept;
  const score = (e: VaultEntryMeta): [number, number, number, number] => [same(e.owner, run.userId) ? 0 : 1, full(e) ? 1 : 0, -(room(e) ?? UNKNOWN_HEADROOM), liveOn(e.fingerprint)];
  return [...pool].sort((a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return a.name.localeCompare(b.name);
  })[0];
}

// ---------------------------------------------------------------- the store

export interface AddInput {
  name: string;
  kind: VaultKind;
  value: string;
  env?: string;
  owner?: string;
  share?: VaultShare;
  roles?: VaultRole[];
  machines?: string[];
}

export type UpdateInput = Partial<Pick<VaultEntryMeta, 'owner' | 'share' | 'roles' | 'machines' | 'disabled'>>;

/** What a run gets from the vault: one Claude token (with its entry) and the other granted secrets, as environment. */
export interface RunSecrets {
  claude?: { entry: VaultEntryMeta; token: string };
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
  for (const e of f.entries) if (!e || typeof e.id !== 'string' || typeof e.name !== 'string' || !VAULT_KINDS.includes(e.kind) || !e.sealed) return 'an entry is malformed';
  return undefined;
}

export class Vault {
  private readonly o: VaultOptions;
  private data: VaultFile = { version: 1, entries: [] };
  private mtime = -1;
  /** session id → the Claude entry it ran on last (pickClaude's sticky). */
  private readonly lastPick = new Map<string, string>();

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
      key = readKey(src.file);
    } catch (e) {
      return { status: { key: 'unreadable', why: (e as Error).message, keyFile: src.file } };
    }
    if (this.data.keyId && this.data.keyId !== keyIdOf(key)) return { status: { key: 'wrong', why: `the vault key ${src.file} did not seal these entries (rotate each one, or put the old key back)`, keyFile: src.file } };
    return { key, status: { key: 'loaded', keyFile: src.file } };
  }

  status(): VaultStatus {
    this.reload();
    return { ...this.key().status, entries: this.data.entries.length };
  }

  list(): VaultEntryMeta[] {
    this.reload();
    return this.data.entries.map(({ sealed: _s, ...meta }) => ({ ...meta, roles: [...meta.roles], machines: [...meta.machines] }));
  }

  private find(name: string): VaultEntry {
    const e = this.data.entries.find((x) => x.name === name || x.id === name);
    if (!e) throw new Error(`no vault entry named ${name}`);
    return e;
  }

  /** Lock, re-read, change, write: fffctl and the portal may both write. */
  private change<T>(fn: (key: Buffer | undefined) => T, needKey: boolean): T {
    const lock = `${this.o.file}.lock`;
    fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
    let fd: number | undefined;
    for (let i = 0; i < 50 && fd === undefined; i++) {
      try {
        fd = fs.openSync(lock, 'wx', 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // A lock left by a crash is stale after 10 s.
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true });
        } catch {
          // gone meanwhile
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
    if (fd === undefined) throw new Error(`the vault is locked by another writer (${lock})`);
    try {
      this.mtime = -1;
      this.reload();
      const k = this.key();
      if (needKey && !k.key) throw new Error(`the vault cannot seal values: ${k.status.why}`);
      const out = fn(k.key);
      if (k.key) this.data.keyId ??= keyIdOf(k.key);
      writeJsonDurable(this.o.file, this.data, { indent: 2, mode: 0o600, generations: 0 });
      if (this.o.chownLike) {
        const st = fs.statSync(this.o.chownLike);
        fs.chownSync(this.o.file, st.uid, st.gid);
      }
      this.mtime = fs.statSync(this.o.file).mtimeMs;
      this.publishValues();
      return out;
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }

  private checkGrant(i: UpdateInput & { kind: VaultKind }) {
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
    const grant = { kind: i.kind, share, owner: i.owner, roles: i.roles ?? ['workers', 'standing'], machines: (i.machines ?? ['*']).map((m) => m.toLowerCase()) };
    this.checkGrant(grant);
    if (share === 'owner' && !i.owner) throw new Error('an entry for its owner\'s own work needs --owner (a portal user id), or share it with "anyone"');
    return this.change((key) => {
      if (this.data.entries.some((e) => e.name === i.name)) throw new Error(`a vault entry named ${i.name} exists; rotate it instead`);
      const fp = fingerprintOf(i.value);
      const dup = this.data.entries.find((e) => e.fingerprint === fp);
      if (dup) throw new Error(`that value is already in the vault as ${dup.name}`);
      const at = this.now();
      const meta: VaultEntryMeta = { id: randomBytes(4).toString('hex'), name: i.name, kind: i.kind, ...(i.env ? { env: i.env } : {}), ...(i.owner ? { owner: i.owner } : {}), share, roles: grant.roles, machines: grant.machines, fingerprint: fp, last4: i.value.slice(-4), createdAt: at, updatedAt: at };
      this.data.entries.push({ ...meta, sealed: seal(key!, meta, i.value) });
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
      Object.assign(e, { fingerprint: fp, last4: value.slice(-4), rotatedAt: at, updatedAt: at, sealed: seal(key!, e, value) });
      const { sealed: _s, ...meta } = e;
      return meta;
    }, true);
  }

  update(name: string, patch: UpdateInput): VaultEntryMeta {
    return this.change(() => {
      const e = this.find(name);
      const p = { ...patch, ...(patch.machines ? { machines: patch.machines.map((m) => m.toLowerCase()) } : {}) };
      this.checkGrant({ ...p, kind: e.kind });
      const next = { ...e, ...p };
      if (next.owner === '') delete next.owner;
      if (next.share === 'owner' && !next.owner) throw new Error('an entry for its owner\'s own work needs an owner');
      Object.assign(e, next, { updatedAt: this.now() });
      if (!next.owner) delete e.owner;
      if (!next.disabled) delete e.disabled;
      const { sealed: _s, ...meta } = e;
      return meta;
    }, false);
  }

  remove(name: string): VaultEntryMeta {
    return this.change(() => {
      const e = this.find(name);
      this.data.entries = this.data.entries.filter((x) => x.id !== e.id);
      for (const [s, id] of this.lastPick) if (id === e.id) this.lastPick.delete(s);
      const { sealed: _s, ...meta } = e;
      return meta;
    }, false);
  }

  /** A session ended for good: forget its sticky pick. */
  forgetSession(sessionId: string) {
    this.lastPick.delete(sessionId);
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
  claudeTokens(): { token: string; label: string; fingerprint: string; where: string }[] {
    this.reload();
    const { key } = this.key();
    if (!key) return [];
    return this.data.entries
      .filter((e) => e.kind === 'claude' && !e.disabled)
      .map((e) => ({ e, token: this.open(key, e) }))
      .filter((x): x is { e: VaultEntry; token: string } => !!x.token)
      .map(({ e, token }) => ({ token, label: `vault: ${e.name} …${e.last4}`, fingerprint: e.fingerprint, where: `the token vault: ${e.roles.join(', ')} on ${e.machines.includes('*') ? 'every machine' : e.machines.join(', ')}${e.share === 'owner' ? `, ${e.owner}'s own work` : ''}` }));
  }

  /**
   * What a run gets (docs/vault.md, section 3): with `claude`, one Claude token chosen by pickClaude; and every other
   * entry granted to the run's role and machine, as environment. Nothing when the key is missing (the problems say so).
   */
  forRun(run: VaultRun, o: { claude: boolean; usageOf?: (fingerprint: string) => PlanUsage | undefined; liveOn?: (fingerprint: string) => number }): RunSecrets {
    this.reload();
    const out: RunSecrets = { env: {}, problems: [] };
    const granted = this.data.entries.filter((e) => eligible(e, run));
    const wanted = granted.filter((e) => e.kind !== 'claude' || o.claude);
    if (!wanted.length) return out;
    const { key, status } = this.key();
    if (!key) {
      out.problems.push(`the vault cannot open ${wanted.map((e) => e.name).join(', ')}: ${status.why}`);
      return out;
    }
    for (const e of granted) {
      if (e.kind === 'claude') continue;
      const v = this.open(key, e);
      if (!v) {
        out.problems.push(`vault entry ${e.name} does not open with this key`);
        continue;
      }
      if (e.kind === 'github') out.env.GH_TOKEN = v;
      else if (e.env) out.env[e.env] = v;
    }
    if (o.claude) {
      const sticky = run.sessionId ? this.lastPick.get(run.sessionId) : undefined;
      const tried = new Set<string>();
      // A token that does not open (sealed by another key) is skipped for the next best.
      for (;;) {
        const pick = pickClaude(
          granted.filter((e) => !tried.has(e.id)),
          run,
          o.usageOf,
          o.liveOn,
          sticky,
        );
        if (!pick) break;
        const v = this.open(key, this.find(pick.id));
        if (v) {
          if (run.sessionId) this.lastPick.set(run.sessionId, pick.id);
          const { sealed: _s, ...meta } = this.find(pick.id);
          out.claude = { entry: meta, token: v };
          break;
        }
        tried.add(pick.id);
        out.problems.push(`vault entry ${pick.name} does not open with this key`);
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
  liveOn?: (fingerprint: string) => number;
  payer?: () => string | undefined;
  /** A run that wanted a vault Claude token and fell back, or an entry that would not open: for the log and system_status. */
  onProblem?: (line: string) => void;
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
