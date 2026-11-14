import path from 'node:path';
import type http from 'node:http';
import { randomBytes } from 'node:crypto';
import { checkArray, readJsonDurable, writeJsonDurable } from './durable.ts';

/**
 * Device approval (docs/identity.md, "Device approval"): with config `deviceApproval` "members", a member's right password
 * on a browser an owner has not approved for them opens no session; the login waits as a request an owner approves or
 * denies in the portal. A browser is known by a random 256-bit id in its own cookie (ffsb_device); only the id's SHA-256 is
 * kept (data/devices.json), per login, so one browser shared by two people is approved for each of them separately. A
 * one-time set-password link approves the browser that redeems it: the owner minted the link for that person.
 */
export type DeviceApproval = 'off' | 'members';
export const DEVICE_APPROVALS: readonly DeviceApproval[] = ['off', 'members'];
export const DEVICE_COOKIE = 'ffsb_device';
/** Browsers cap a cookie's life at 400 days. */
const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 3600;
/** A request nobody answered is dropped after a week; a refusal is remembered for 30 days, then the browser may ask again. */
const PENDING_TTL_MS = 7 * 24 * 3600 * 1000;
const DENIED_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_RECORDS = 500;

export type DeviceStatus = 'pending' | 'approved' | 'denied';

export interface DeviceRecord {
  /** A short public id the owner's page and the routes name it by; never the cookie's value. */
  id: string;
  username: string;
  /** SHA-256 of the browser's device cookie. */
  sha256: string;
  status: DeviceStatus;
  /** "Safari on iPhone", from its User-Agent. */
  label: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  decidedAt?: string;
  /** The owner who decided, or "set-password link". */
  decidedBy?: string;
  lastSeenAt?: string;
}

export type DeviceView = Omit<DeviceRecord, 'sha256'>;

/** A short readable name for a User-Agent: the browser and the system, enough for an owner to recognise it. */
export function deviceLabel(ua: string): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'an unknown system';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /OPR\//.test(ua) ? 'Opera' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  return `${browser} on ${os}`;
}

export class Devices {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'devices.json');
  }

  /** Every record still kept: unanswered requests for a week, refusals for 30 days, approvals until revoked. */
  all(now = Date.now()): DeviceRecord[] {
    const raw = readJsonDurable<DeviceRecord[]>(this.file, { check: checkArray }) ?? [];
    return raw.filter((d) => d.status === 'approved' || now - Date.parse(d.decidedAt ?? d.createdAt) < (d.status === 'pending' ? PENDING_TTL_MS : DENIED_TTL_MS));
  }

  list(): DeviceView[] {
    return this.all().map(({ sha256: _, ...v }) => v);
  }

  find(username: string, sha256: string | undefined): DeviceRecord | undefined {
    return sha256 ? this.all().find((d) => d.username === username && d.sha256 === sha256) : undefined;
  }

  byId(id: string): DeviceRecord | undefined {
    return this.all().find((d) => d.id === id);
  }

  private write(list: DeviceRecord[]) {
    // Oldest first out when a flood of requests would grow it without end; approvals are kept before anything else.
    const keep = list.length > MAX_RECORDS ? [...list.filter((d) => d.status === 'approved'), ...list.filter((d) => d.status !== 'approved').slice(-MAX_RECORDS)] : list;
    writeJsonDurable(this.file, keep, { indent: 2 });
  }

  /**
   * The record for this browser and login, made `status` when there is none (a new request, or an approval by link).
   * An existing record keeps its status unless `status` is "approved" by link; its last-seen time is updated.
   */
  upsert(username: string, sha256: string, req: http.IncomingMessage, ip: string, status: DeviceStatus, decidedBy?: string): DeviceRecord {
    const list = this.all();
    const now = new Date().toISOString();
    const old = list.find((d) => d.username === username && d.sha256 === sha256);
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);
    if (old) {
      old.lastSeenAt = now;
      old.ip = ip;
      if (status === 'approved' && old.status !== 'approved') Object.assign(old, { status, decidedAt: now, decidedBy });
      this.write(list);
      return old;
    }
    const rec: DeviceRecord = { id: `d${randomBytes(6).toString('base64url')}`, username, sha256, status, label: deviceLabel(ua), userAgent: ua, ip, createdAt: now, lastSeenAt: now, ...(status !== 'pending' ? { decidedAt: now, decidedBy } : {}) };
    this.write([...list, rec]);
    return rec;
  }

  /** Forget every device of a login, pending, approved or denied (a deleted login, w10): how many there were. */
  removeUser(username: string): number {
    const list = this.all();
    const keep = list.filter((d) => d.username !== username);
    if (keep.length !== list.length) this.write(keep);
    return list.length - keep.length;
  }

  /** Approve or deny a request (either way round, so a refusal can be undone), or forget a device altogether (revoke). */
  decide(id: string, action: 'approve' | 'deny' | 'revoke', by: string): DeviceRecord {
    const list = this.all();
    const d = list.find((x) => x.id === id);
    if (!d) throw new Error(`no device "${id}"`);
    if (action === 'revoke') this.write(list.filter((x) => x !== d));
    else {
      Object.assign(d, { status: action === 'approve' ? 'approved' : 'denied', decidedAt: new Date().toISOString(), decidedBy: by });
      this.write(list);
    }
    return d;
  }
}

/** A browser's device id from its cookie, if it sent a well-formed one. */
export function deviceId(req: http.IncomingMessage): string | undefined {
  return new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie ?? '')?.[1];
}

export const newDeviceId = () => randomBytes(32).toString('hex');

export function deviceCookie(id: string, secure: boolean) {
  return `${DEVICE_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`;
}
