import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { UserInfo, UserRole } from '../shared/types.ts';
import { checkArray, checkObject, isObject, readJsonDurable, writeJsonDurable, type Check } from './durable.ts';
import { Devices, deviceCookie, deviceId, newDeviceId, type DeviceApproval, type DeviceRecord, type DeviceView } from './devices.ts';

/**
 * Username/password login. This page can drive agents that run shell commands on the host, so it
 * is treated as a shell login:
 *   - passwords are stored as scrypt hashes (data/users.json), never in config;
 *   - sessions are random 256-bit ids; only their SHA-256 is kept server-side
 *     (data/auth-sessions.json), so reading that file does not yield a usable cookie; 30-day expiry,
 *     revocable by deleting the file or logging out;
 *   - cookies are HttpOnly + SameSite=Strict (+ Secure behind HTTPS);
 *   - failed logins are rate limited per client IP and globally; an attempt is counted BEFORE the
 *     slow hash (so a burst of parallel guesses cannot all slip in), and at most two password hashes
 *     run at once. Bad API keys are throttled per IP separately, so they cannot lock out a login; a good key
 *     is never throttled;
 *   - a one-time set-password link (w3714, `node server/user.ts <name> --link`) is a random 256-bit token whose
 *     SHA-256 alone is kept (data/password-links.json); it sets that login's password once, within its hours, and its
 *     wrong guesses count as failed logins;
 *   - device approval (config deviceApproval, server/devices.ts): with "members", a member's right password on a browser no
 *     owner approved for them opens no session but a request an owner answers in the portal; the browser that redeems a
 *     set-password link is approved by it.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const SCRYPT: ScryptOptions = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const LINK_TTL_MS = 24 * 3600 * 1000;
export const COOKIE = 'ffsb_session';

interface UserRecord {
  username: string;
  /** scrypt$N$r$p$saltB64$hashB64 */
  hash: string;
  /** Shown in transcripts and on agents ("Lothsahn"); default the username. */
  displayName?: string;
  /** Absent in files written before roles: those logins were all the owner's, so they read as owner. */
  role?: UserRole;
}

export interface UserProfile {
  displayName?: string;
  role?: UserRole;
}

const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim();

interface SessionRecord {
  username: string;
  expires: number;
  /** SHA-256 of the browser's device cookie, when it sent one: revoking that device ends the session. */
  device?: string;
}

export type LoginResult =
  | { ok: true; cookie: string; deviceCookie?: string }
  | { ok: false; status: number; error: string; pending?: boolean; deviceCookie?: string };

function scryptAsync(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, KEYLEN, opts, (e, k) => (e ? reject(e) : resolve(k))));
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string) {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** The profile fields to store, checked. */
function checkProfile(p: UserProfile): Partial<UserRecord> {
  const out: Partial<UserRecord> = {};
  if (p.displayName !== undefined) {
    const n = cleanName(p.displayName);
    // It is shown in prompts ("[from Lothsahn]") and transcripts: one plain line.
    if (!n || n.length > 40 || /[<>`{}$\\[\]]/.test(n)) throw new Error('display name: 1-40 characters, one line, none of <>`{}$\\[]');
    out.displayName = n;
  }
  if (p.role !== undefined) {
    if (p.role !== 'owner' && p.role !== 'member') throw new Error('role is owner or member');
    out.role = p.role;
  }
  return out;
}

/**
 * What a scoped API key may reach, and nothing else (docs/intake.md): "nightly" the nightly e2e lab's report endpoint,
 * "ffbox" FFBox's escalations from Max (POST /api/intake/ffbox).
 */
export type ApiKeyScope = 'nightly' | 'ffbox';
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['nightly', 'ffbox'];

/** users.json: a list of logins, each with a name and a password hash. */
const checkUsers: Check = (v) => (Array.isArray(v) && v.every((u) => isObject(u) && typeof u.username === 'string' && typeof u.hash === 'string') ? undefined : 'not a list of logins');

type LinkRecord = { sha256: string; username: string; expires: number };

type ApiKeyRecord = { name: string; sha256: string; createdAt: string; user?: string; scope?: ApiKeyScope };

export class Auth {
  private readonly usersFile: string;
  private readonly sessionsFile: string;
  private readonly linksFile: string;
  private sessions = new Map<string, SessionRecord>();
  private readonly failures = new Map<string, number[]>();
  private globalFailures: number[] = [];
  private readonly keyFailures = new Map<string, number[]>();
  private hashing = 0;
  /** A hash to verify against when the username does not exist, so timing does not reveal valid names. */
  private readonly dummyHash: Promise<string>;
  private readonly trustProxyOpt: boolean | (() => boolean);
  private readonly deviceApproval: () => DeviceApproval;
  readonly devices: Devices;
  /** Told when a member's login from a new browser starts waiting for an owner (index.ts: a push to the owners). */
  onDevicePending?: (d: DeviceView) => void;

  /** opts: trustProxy and deviceApproval as config has them now (a function reads it live). */
  constructor(dataDir: string, opts: { trustProxy: boolean | (() => boolean); deviceApproval?: () => DeviceApproval }) {
    this.usersFile = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'auth-sessions.json');
    this.linksFile = path.join(dataDir, 'password-links.json');
    this.trustProxyOpt = opts.trustProxy;
    this.deviceApproval = opts.deviceApproval ?? (() => 'off');
    this.devices = new Devices(dataDir);
    const raw = readJsonDurable<Record<string, SessionRecord>>(this.sessionsFile, { check: checkObject });
    const now = Date.now();
    for (const [id, s] of Object.entries(raw ?? {})) if (s.expires > now) this.sessions.set(id, s);
    this.dummyHash = hashPassword(randomBytes(16).toString('hex'));
  }

  users(): UserRecord[] {
    return readJsonDurable<UserRecord[]>(this.usersFile, { check: checkUsers }) ?? [];
  }

  hasUsers() {
    return this.users().length > 0;
  }

  /** Every login as the rest of the app sees it (no hashes): user id = username, display name, role. */
  userInfos(): UserInfo[] {
    return this.users().map((u) => ({ userId: u.username, displayName: u.displayName || u.username, role: u.role ?? 'owner' }));
  }

  userInfo(username: string | undefined): UserInfo | undefined {
    return username ? this.userInfos().find((u) => u.userId === username) : undefined;
  }

  /**
   * Create a login or change its password. `profile` sets its display name and role; without it an existing
   * login keeps its own, and a new one is the owner when it is the first login, a member otherwise.
   */
  async setUser(username: string, password: string, profile: UserProfile = {}) {
    if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) throw new Error('username: 2-32 letters, digits, . _ -');
    if (password.length < 12) throw new Error('password must be at least 12 characters');
    const all = this.users();
    const old = all.find((u) => u.username === username);
    const rec: UserRecord = { ...old, username, hash: await hashPassword(password), ...checkProfile(profile) };
    rec.role ??= old ? 'owner' : all.length ? 'member' : 'owner';
    this.writeUsers([...all.filter((u) => u.username !== username), rec]);
    // A password change logs that user out everywhere.
    for (const [id, s] of this.sessions) if (s.username === username) this.sessions.delete(id);
    this.persistSessions();
  }

  /** Change a login's display name or role, keeping its password and sessions. */
  setProfile(username: string, profile: UserProfile) {
    const all = this.users();
    const old = all.find((u) => u.username === username);
    if (!old) throw new Error(`no login "${username}"`);
    const p = checkProfile(profile);
    this.writeUsers(all.map((u) => (u === old ? { ...u, ...p } : u)));
  }

  /**
   * Remove a login with its API keys and its sessions (w1864; the rest of what a login leaves, its pool entry and its
   * orchestrator, is server/userDelete.ts's). Refused for a missing login and for the last owner. Returns the names of the
   * keys it removed (never a key: only their hashes are kept) and how many sessions it ended.
   */
  deleteUser(username: string): { keys: string[]; sessions: number } {
    const all = this.users();
    const old = all.find((u) => u.username === username);
    if (!old) throw new Error(`no login "${username}"`);
    if ((old.role ?? 'owner') === 'owner' && all.filter((u) => (u.role ?? 'owner') === 'owner').length < 2) throw new Error(`"${username}" is the last owner login: make another login an owner first`);
    const keys = this.keys();
    const theirs = keys.filter((k) => k.user === username).map((k) => k.name);
    if (theirs.length) writeJsonDurable(this.keysFile, keys.filter((k) => k.user !== username), { indent: 2 });
    this.writeUsers(all.filter((u) => u !== old));
    let sessions = 0;
    for (const [id, s] of this.sessions) if (s.username === username && this.sessions.delete(id)) sessions++;
    if (sessions) this.persistSessions();
    return { keys: theirs, sessions };
  }

  private writeUsers(users: UserRecord[]) {
    writeJsonDurable(this.usersFile, users, { indent: 2 });
  }

  // ---- API keys, for machine clients such as a remote Claude Code's MCP connection ----

  private get keysFile() {
    return path.join(path.dirname(this.usersFile), 'api-keys.json');
  }

  private keys(): ApiKeyRecord[] {
    return readJsonDurable<ApiKeyRecord[]>(this.keysFile, { check: checkArray }) ?? [];
  }

  /**
   * Mint a key (shown once; only its SHA-256 is stored). Re-minting a name replaces its old key. `user`: the login
   * it acts for (work it starts is requested by them); a key without one acts for the owner. `scope`: a key for one
   * endpoint only ("nightly": POST /api/intake/nightly), refused on /mcp; a key without one is an MCP key.
   */
  createApiKey(name: string, user?: string, scope?: ApiKeyScope) {
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(name)) throw new Error('key name: 2-40 letters, digits, . _ -');
    if (scope !== undefined && !API_KEY_SCOPES.includes(scope)) throw new Error(`key scope: one of ${API_KEY_SCOPES.join(', ')}`);
    if (user !== undefined && !this.users().some((u) => u.username === user)) throw new Error(`no login "${user}" to bind the key to`);
    const key = `ffsb_${randomBytes(32).toString('base64url')}`;
    const sha256 = createHash('sha256').update(key).digest('hex');
    const keys = this.keys().filter((k) => k.name !== name);
    keys.push({ name, sha256, createdAt: new Date().toISOString(), ...(user ? { user } : {}), ...(scope ? { scope } : {}) });
    writeJsonDurable(this.keysFile, keys, { indent: 2 });
    return key;
  }

  /** Every key without its hash: name, the login it acts for, its scope and when it was made (fffctl apikey list, w1415). */
  apiKeyInfos(): { name: string; createdAt: string; user?: string; scope?: ApiKeyScope }[] {
    return this.keys().map(({ name, createdAt, user, scope }) => ({ name, createdAt, ...(user ? { user } : {}), ...(scope ? { scope } : {}) }));
  }

  revokeApiKey(name: string) {
    const keys = this.keys();
    writeJsonDurable(this.keysFile, keys.filter((k) => k.name !== name), { indent: 2 });
    return keys.some((k) => k.name === name);
  }

  /**
   * The key's name (and the login it acts for) for a valid "Authorization: Bearer ffsb_…" header. After 10 bad
   * keys from an address in 15 minutes it is answered 429, and refusals then are not counted. A good key always
   * gets in and clears the address (one bad client must not lock out every key behind the same address): keys
   * are 256 random bits checked with one SHA-256, so the throttle is not what stops guessing.
   */
  bearer(req: http.IncomingMessage): { ok: true; name: string; user?: string; scope?: ApiKeyScope } | { ok: false; status: number } {
    const ip = this.clientIp(req);
    const now = Date.now();
    const recent = (this.keyFailures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    const m = /^Bearer\s+(ffsb_[A-Za-z0-9_-]{20,})$/.exec(String(req.headers.authorization ?? ''));
    const digest = m ? createHash('sha256').update(m[1]).digest() : undefined;
    const hit = digest && this.keys().find((k) => timingSafeEqual(Buffer.from(k.sha256, 'hex'), digest));
    if (hit) {
      this.keyFailures.delete(ip);
      return { ok: true, name: hit.name, ...(hit.user ? { user: hit.user } : {}), ...(hit.scope ? { scope: hit.scope } : {}) };
    }
    const locked = recent.length >= 10;
    if (!locked) recent.push(now);
    this.keyFailures.set(ip, recent);
    if (locked) return { ok: false, status: 429 };
    console.warn(`bad API key from ${ip}`);
    return { ok: false, status: 401 };
  }

  private get trustProxy() {
    return typeof this.trustProxyOpt === 'function' ? this.trustProxyOpt() : this.trustProxyOpt;
  }

  /** The client address, taking X-Forwarded-For only from a local reverse proxy (Tailscale serve/funnel). */
  clientIp(req: http.IncomingMessage) {
    const direct = req.socket.remoteAddress ?? '?';
    const local = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
    if (this.trustProxy && local) {
      const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return direct;
  }

  /** Whether the browser reached us over HTTPS (directly or via a local TLS-terminating proxy). */
  isHttps(req: http.IncomingMessage) {
    return String(req.headers['x-forwarded-proto'] ?? '').includes('https') || !!(req.socket as { encrypted?: boolean }).encrypted;
  }

  private throttled(ip: string) {
    const now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    this.failures.set(ip, recent);
    this.globalFailures = this.globalFailures.filter((t) => now - t < 60_000);
    return recent.length >= 5 || this.globalFailures.length >= 20;
  }

  async login(req: http.IncomingMessage, username: string, password: string): Promise<LoginResult> {
    const ip = this.clientIp(req);
    if (this.throttled(ip)) return { ok: false, status: 429, error: 'Too many failed attempts. Try again in 15 minutes.' };
    if (this.hashing >= 2) return { ok: false, status: 429, error: 'Busy, try again in a moment.' };
    // Count the attempt as a failure up front; a success takes it back.
    const stamp = Date.now();
    this.failures.get(ip)!.push(stamp);
    this.globalFailures.push(stamp);
    const user = this.users().find((u) => u.username === username);
    this.hashing++;
    let valid = false;
    try {
      // Before the dummy hash is ready, wait for it: a made-up hash would answer faster (or throw).
      valid = await verifyPassword(password, user?.hash ?? (await this.dummyHash));
    } finally {
      this.hashing--;
    }
    if (!user || !valid) {
      console.warn(`login failed for "${username}" from ${ip}`);
      return { ok: false, status: 401, error: 'Wrong username or password.' };
    }
    this.failures.delete(ip);
    this.globalFailures = this.globalFailures.filter((t) => t !== stamp);
    if (this.needsApproval(user)) {
      const given = deviceId(req);
      const dev = given ?? newDeviceId();
      const setDevice = given ? undefined : deviceCookie(dev, this.isHttps(req));
      const known = this.devices.find(username, sha(dev));
      if (known?.status !== 'approved') {
        if (known?.status === 'denied') {
          console.warn(`login for "${username}" from ${ip}: device ${known.id} was refused`);
          return { ok: false, status: 403, error: 'An owner refused this device. Ask them to approve it in FF Factory.' };
        }
        const d = this.devices.upsert(username, sha(dev), req, ip, 'pending');
        console.log(`login for "${username}" from ${ip} waits for an owner to approve device ${d.id} (${d.label})`);
        if (!known) this.onDevicePending?.(this.view(d));
        return { ok: false, status: 202, pending: true, error: 'This device is new: an owner must approve it in FF Factory. This page signs you in once they do.', ...(setDevice ? { deviceCookie: setDevice } : {}) };
      }
      this.devices.upsert(username, sha(dev), req, ip, 'approved');
      console.log(`login ok for "${username}" from ${ip} on approved device ${known.id}`);
      return { ok: true, cookie: this.newSession(req, username, sha(dev)) };
    }
    console.log(`login ok for "${username}" from ${ip}`);
    const dev = deviceId(req);
    return { ok: true, cookie: this.newSession(req, username, dev && sha(dev)) };
  }

  /** Whether `user`'s logins need an owner's approval for each new browser: config deviceApproval "members", and a member. */
  private needsApproval(user: UserRecord) {
    return this.deviceApproval() === 'members' && (user.role ?? 'owner') === 'member';
  }

  private view({ sha256: _, ...v }: DeviceRecord): DeviceView {
    return v;
  }

  /** Every device request and approval, for the owners' page (no cookie hashes). */
  deviceList(): DeviceView[] {
    return this.devices.list();
  }

  /** An owner approves, denies or revokes a device; denying or revoking ends that browser's sessions of that login. */
  decideDevice(id: string, action: 'approve' | 'deny' | 'revoke', by: string): DeviceView {
    const d = this.devices.decide(id, action, by);
    if (action !== 'approve') {
      let n = 0;
      for (const [k, s] of this.sessions) if (s.username === d.username && s.device === d.sha256 && this.sessions.delete(k)) n++;
      if (n) this.persistSessions();
    }
    console.log(`device ${d.id} of "${d.username}" (${d.label}): ${action} by ${by}`);
    return this.view(d);
  }

  private newSession(req: http.IncomingMessage, username: string, device?: string): string {
    const id = randomBytes(32).toString('hex');
    this.sessions.set(sha(id), { username, expires: Date.now() + SESSION_TTL_MS, ...(device ? { device } : {}) });
    this.persistSessions();
    const secure = this.isHttps(req) ? '; Secure' : '';
    return `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
  }

  private links(now = Date.now()): LinkRecord[] {
    return (readJsonDurable<LinkRecord[]>(this.linksFile, { check: checkArray }) ?? []).filter((l) => l.expires > now);
  }

  /**
   * A one-time link token that lets whoever holds it set `username`'s password (w3714: a person who never had the
   * password picks their own, and no password passes through a chat). Replaces any earlier link of that login.
   */
  mintPasswordLink(username: string, ttlMs = LINK_TTL_MS): { token: string; expires: number } {
    if (!this.users().some((u) => u.username === username)) throw new Error(`no login "${username}"`);
    const token = randomBytes(32).toString('base64url');
    const expires = Date.now() + ttlMs;
    writeJsonDurable(this.linksFile, [...this.links().filter((l) => l.username !== username), { sha256: sha(token), username, expires }]);
    return { token, expires };
  }

  /** Set the password a link names, once, and log that browser in (every other session of the login ends). */
  async usePasswordLink(req: http.IncomingMessage, token: string, password: string): Promise<{ ok: true; username: string; cookie: string; deviceCookie?: string } | { ok: false; status: number; error: string }> {
    const ip = this.clientIp(req);
    if (this.throttled(ip)) return { ok: false, status: 429, error: 'Too many failed attempts. Try again in 15 minutes.' };
    const all = this.links();
    const hit = all.find((l) => l.sha256 === sha(token));
    if (!hit) {
      const stamp = Date.now();
      this.failures.get(ip)!.push(stamp);
      this.globalFailures.push(stamp);
      console.warn(`set-password link refused from ${ip}`);
      return { ok: false, status: 401, error: 'This link is used, expired or mistyped. Ask for a new one.' };
    }
    if (password.length < 12) return { ok: false, status: 400, error: 'The password must be at least 12 characters.' };
    writeJsonDurable(this.linksFile, all.filter((l) => l !== hit));
    await this.setUser(hit.username, password);
    // The owner minted the link for this person: the browser that redeems it is approved for them (device approval).
    const given = deviceId(req);
    const dev = given ?? newDeviceId();
    const d = this.devices.upsert(hit.username, sha(dev), req, ip, 'approved', 'set-password link');
    console.log(`password set by link for "${hit.username}" from ${ip}; device ${d.id} (${d.label}) approved by the link`);
    return { ok: true, username: hit.username, cookie: this.newSession(req, hit.username, sha(dev)), ...(given ? {} : { deviceCookie: deviceCookie(dev, this.isHttps(req)) }) };
  }

  logout(req: http.IncomingMessage) {
    const id = this.sessionId(req);
    if (id && this.sessions.delete(sha(id))) this.persistSessions();
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  private sessionId(req: http.IncomingMessage) {
    return new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie ?? '')?.[1];
  }

  /** The logged-in username, or undefined. */
  user(req: http.IncomingMessage): string | undefined {
    const id = this.sessionId(req);
    if (!id) return undefined;
    const key = sha(id);
    const s = this.sessions.get(key);
    if (!s) return undefined;
    if (s.expires < Date.now()) {
      this.sessions.delete(key);
      this.persistSessions();
      return undefined;
    }
    return s.username;
  }

  private persistSessions() {
    writeJsonDurable(this.sessionsFile, Object.fromEntries(this.sessions));
  }
}
