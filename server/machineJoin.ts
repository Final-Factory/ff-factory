import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { isObject, readJsonDurable, writeJsonDurable } from './durable.ts';
import { MACHINE_ID, withFileLock } from './machineTokens.ts';

/**
 * One-step machine join (w1592, docs/worker-install.md "Adding a machine with a join code"). An owner asks for a join
 * code (add_machine with join_code): that is their approval of the new machine, made in their own words as add_machine
 * always was. The code is bound to one machine id, to the tailnet device it may be redeemed from and to the limits the
 * owner gave, works once and lapses after JOIN_TTL_MINUTES. The bootstrap on the new PC (scripts/worker/join.ps1,
 * join.sh) redeems it over the tailnet at POST /machine/join (server/machineJoinHttp.ts): the portal checks the device
 * with `tailscale whois`, makes the record and answers the machine's credential, which the bootstrap writes straight into
 * a file for the installer. Only the code's hash is kept, never the code.
 */

export const JOIN_TTL_MINUTES = 60;

/** The tag a joined PC carries so that the portal's tcp:22 grant reaches it (docs/worker-install.md, "The tailnet"). */
export const WORKER_TAG = 'tag:fff-worker';

export const machineJoinsFile = (dataDir: string) => path.join(dataDir, 'machine-joins.json');

export interface JoinLimits {
  maxSandboxes?: number;
  maxAgentsPerSandbox?: number;
  maxUnity?: number;
}

/** What the bootstrap says about the PC, for its default limits. Every field is optional and checked. */
export interface JoinFacts {
  os?: string;
  ramGB?: number;
  cpus?: number;
  freeGB?: number;
}

/** A code waiting to be redeemed, as kept (the hash only) and as listed. */
export interface PendingJoin {
  hash: string;
  machineId: string;
  /** The tailnet device name (MagicDNS short name, lower-case) the code may be redeemed from. */
  tailnetName: string;
  limits: JoinLimits;
  /** The owner whose approval it is (user id). */
  by: string;
  createdAt: string;
  expiresAt: string;
  /** The code's last four characters, for telling two codes apart. */
  last4: string;
}

// Crockford's base32: no I, L, O or U, so a code read off a screen is typed back right.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 20; // 100 bits

/** A fresh code, `XXXXX-XXXXX-XXXXX-XXXXX`. */
export function newJoinCode(): string {
  const c = Array.from({ length: CODE_CHARS }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return c.match(/.{5}/g)!.join('-');
}

/** A typed code in its canonical form (upper-case, no dashes or spaces; O read as 0, I and L as 1), or undefined. */
export function normalizeJoinCode(typed: unknown): string | undefined {
  if (typeof typed !== 'string' || typed.length > 64) return undefined;
  const c = typed
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return c.length === CODE_CHARS && [...c].every((ch) => ALPHABET.includes(ch)) ? c : undefined;
}

const hashOf = (canonical: string) => createHash('sha256').update(`ffjoin:${canonical}`).digest('hex');

/**
 * The limits a PC gets when the code names none (each is overridable at the PC and later with add_machine). From the
 * measurements in docs/unity-lifecycle.md (w469: four Unity processes building took about 45 GB on LothDesktop, an editor
 * with its build about 12 GB) and the disk figures in docs/worker-install.md (a sandbox takes 15 to 125 GB): an editor per
 * 16 GB above an 8 GB floor and per 4 logical CPUs, 1 to 4; one sandbox more than editors, at most one per 60 GB free;
 * 2 agents per sandbox (a Claude process is about 0.6 GB). Without RAM figures: the installer's own defaults, 3, 2, 2.
 */
export function defaultLimits(f: JoinFacts): Required<JoinLimits> & { why: string } {
  if (!f.ramGB) return { maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2, why: "no RAM figure: the installer's defaults" };
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n)));
  let maxUnity = clamp((f.ramGB - 8) / 16, 1, 4);
  if (f.cpus) maxUnity = Math.min(maxUnity, clamp(f.cpus / 4, 1, 4));
  let maxSandboxes = clamp(maxUnity + 1, 1, 8);
  if (f.freeGB !== undefined) maxSandboxes = Math.min(maxSandboxes, clamp(f.freeGB / 60, 1, 8));
  const why = `${Math.round(f.ramGB)} GB RAM${f.cpus ? `, ${f.cpus} CPUs` : ''}${f.freeGB !== undefined ? `, ${Math.round(f.freeGB)} GB free` : ''}`;
  return { maxSandboxes, maxAgentsPerSandbox: 2, maxUnity, why };
}

/** The bootstrap's facts, checked: numbers in sane ranges only, anything else left out. */
export function parseFacts(raw: unknown): JoinFacts {
  if (!isObject(raw)) return {};
  const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : undefined);
  const out: JoinFacts = {};
  if (typeof raw.os === 'string' && /^(windows|macos|linux)$/.test(raw.os)) out.os = raw.os;
  const ram = num(raw.ramGB, 65536);
  const cpus = num(raw.cpus, 4096);
  const free = typeof raw.freeGB === 'number' && Number.isFinite(raw.freeGB) && raw.freeGB >= 0 && raw.freeGB <= 1e7 ? raw.freeGB : undefined;
  if (ram) out.ramGB = ram;
  if (cpus) out.cpus = Math.floor(cpus);
  if (free !== undefined) out.freeGB = free;
  return out;
}

/** A limit given with a code, checked as add_machine checks it. */
export function checkJoinLimits(l: JoinLimits): JoinLimits {
  const out: JoinLimits = {};
  const pick = (k: keyof JoinLimits, min: number, max: number) => {
    const v = l[k];
    if (v === undefined) return;
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${k} must be a whole number from ${min} to ${max}`);
    out[k] = v;
  };
  pick('maxSandboxes', 1, 8);
  pick('maxAgentsPerSandbox', 1, 8);
  pick('maxUnity', 0, 8);
  return out;
}

/** A tailnet device name as `tailscale whois` and MagicDNS give it: its first label, lower-case. */
export function tailnetShortName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '').split('.')[0];
}

const TAILNET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** What `tailscale whois --json <ip>` says about the device behind an address. */
export interface TailnetDevice {
  name: string;
  tags: string[];
  login?: string;
}

/** `tailscale whois --json` output (apitype.WhoIsResponse: Node.Name, Node.ComputedName, Node.Tags, UserProfile.LoginName). */
export function parseWhois(text: string): TailnetDevice | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(j) || !isObject(j.Node)) return undefined;
  const raw = typeof j.Node.ComputedName === 'string' && j.Node.ComputedName ? j.Node.ComputedName : typeof j.Node.Name === 'string' ? j.Node.Name : '';
  const name = tailnetShortName(raw);
  if (!TAILNET_NAME.test(name)) return undefined;
  const tags = Array.isArray(j.Node.Tags) ? j.Node.Tags.filter((t): t is string => typeof t === 'string') : [];
  const login = isObject(j.UserProfile) && typeof j.UserProfile.LoginName === 'string' && j.UserProfile.LoginName ? j.UserProfile.LoginName : undefined;
  return { name, tags, ...(login ? { login } : {}) };
}

const checkJoins = (v: unknown) => (Array.isArray(v) && v.every((x) => isObject(x) && typeof x.hash === 'string' && typeof x.machineId === 'string') ? undefined : 'not a list of join codes');

/**
 * The pending join codes, in data/machine-joins.json (0600, hashes only). At most one per machine id: a new code for the
 * same machine replaces the old one. Expired codes are dropped whenever the file is written.
 */
export class JoinCodes {
  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  private read(): PendingJoin[] {
    return readJsonDurable<PendingJoin[]>(this.file, { check: checkJoins, mode: 0o600 }) ?? [];
  }

  private live(all: PendingJoin[]): PendingJoin[] {
    return all.filter((j) => Date.parse(j.expiresAt) > this.now());
  }

  private write(all: PendingJoin[]) {
    writeJsonDurable(this.file, this.live(all), { indent: 2, mode: 0o600 });
  }

  /** A new code for `machineId`, returned once. */
  create(o: { machineId: string; tailnetName: string; limits: JoinLimits; by: string; minutes?: number }): { code: string; expiresAt: string; last4: string } {
    if (!MACHINE_ID.test(o.machineId)) throw new Error(`machine id "${o.machineId}" must be lower-case letters, digits and dashes`);
    const tailnetName = tailnetShortName(o.tailnetName);
    if (!TAILNET_NAME.test(tailnetName)) throw new Error(`tailnet name "${o.tailnetName}" is not a device name (letters, digits and dashes, as the Tailscale admin console shows it)`);
    const minutes = o.minutes ?? JOIN_TTL_MINUTES;
    const code = newJoinCode();
    const canonical = normalizeJoinCode(code)!;
    const j: PendingJoin = {
      hash: hashOf(canonical),
      machineId: o.machineId,
      tailnetName,
      limits: checkJoinLimits(o.limits),
      by: o.by,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + minutes * 60_000).toISOString(),
      last4: canonical.slice(-4),
    };
    withFileLock(this.file, () => this.write([...this.read().filter((x) => x.machineId !== o.machineId), j]));
    return { code, expiresAt: j.expiresAt, last4: j.last4 };
  }

  /** The live code a typed one matches, or undefined (unknown, malformed or expired). Constant-time on the hash. */
  find(typed: unknown): PendingJoin | undefined {
    const c = normalizeJoinCode(typed);
    if (!c) return undefined;
    const want = Buffer.from(hashOf(c), 'hex');
    return this.live(this.read()).find((j) => {
      const got = Buffer.from(j.hash, 'hex');
      return got.length === want.length && timingSafeEqual(got, want);
    });
  }

  /** Use a code up, once its machine's credential is issued: it works once. False when it was already gone. */
  take(j: PendingJoin): boolean {
    return withFileLock(this.file, () => {
      const all = this.read();
      if (!all.some((x) => x.hash === j.hash)) return false;
      this.write(all.filter((x) => x.hash !== j.hash));
      return true;
    });
  }

  /** Drop a machine's pending code (its record was removed). */
  revoke(machineId: string): boolean {
    return withFileLock(this.file, () => {
      const all = this.read();
      if (!all.some((x) => x.machineId === machineId)) return false;
      this.write(all.filter((x) => x.machineId !== machineId));
      return true;
    });
  }

  /** The live codes, for list_machines: never the hash. */
  pending(): Omit<PendingJoin, 'hash'>[] {
    return this.live(this.read()).map(({ hash: _hash, ...rest }) => rest);
  }
}

/** What a join needs of the machine records (MachineManager, a fake in tests). */
export interface JoinRecords {
  /** A machine's record: whether it is a worker root install already, or a record waiting for its installer (play-only: w1993). */
  get(id: string): { root?: string; awaitingInstall?: string; playOnly?: string } | undefined;
}

/**
 * Why `id` cannot get a join code or be joined, or undefined. A machine that is already installed is updated by running
 * the bootstrap (or its installer's update) there again, with no code: a code would only mint a second credential.
 */
export function joinRefusal(records: JoinRecords, id: string): string | undefined {
  const m = records.get(id);
  if (!m) return undefined;
  if (m.root) return `${id} is already installed (worker root ${m.root}): run the bootstrap on it again, which updates it with no code (or ops_worker machine_update). To install it again from nothing, remove_machine it first`;
  if (!m.awaitingInstall) return `${id} already has a record (a daemon deployed over ssh): move it into a worker root with its installer's migrate (docs/worker-install.md, "Migrating"), not a join`;
  return undefined;
}

/** `tailscale whois --json <addr>` on the portal's host (read-only; any local user may ask tailscaled), or undefined. */
export async function tailscaleWhois(run: (cmd: string, args: string[], o: { timeoutMs: number }) => Promise<{ code: number | null; stdout: string }>, addr: string): Promise<TailnetDevice | undefined> {
  if (!/^[0-9a-f:.]+$/i.test(addr)) return undefined;
  const r = await run('tailscale', ['whois', '--json', addr], { timeoutMs: 5000 }).catch(() => undefined);
  return r?.code === 0 ? parseWhois(r.stdout) : undefined;
}
