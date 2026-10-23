// Deleting a login (w1864, lothsahn: "the portal has no way to remove a login"). One step, in the running portal, because
// the portal holds most of what a login leaves in memory (its sessions, the settings in state.json, its orchestrator):
// the login (users.json), its API keys (api-keys.json), its sessions, its pool entry and its own other settings
// (state.json settings: pool, heartbeat, dismissedEvents), its push subscriptions, its own orchestrator (the session, its
// process and transcript) and that orchestrator's memory folder (to the memory trash, MEMORY_TRASH_DAYS days).
//
// `fffctl user delete ID --by LOGIN` (server/userCli.ts) hands the portal a request file in data/login-delete/ and prints
// its answer; the portal's poll (server/index.ts) runs deleteLogin on it. Everything is checked before anything is
// removed. The answer names what went: key names and counts, never a key or a password (only their hashes are kept).
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, UserInfo } from '../shared/types.ts';
import { LOGIN_ID, PROTECTED_LOGINS } from './memberKeys.ts';
import { memoryTrashDir } from './orchestratorMemory.ts';

export class LoginDeleteRefused extends Error {}
const refuse = (msg: string): never => {
  throw new LoginDeleteRefused(msg);
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface LoginDeleteDeps {
  auth: { userInfos(): UserInfo[]; deleteUser(username: string): { keys: string[]; sessions: number } };
  settings(): AppSettings;
  putSettings(patch: Partial<AppSettings>): void;
  /** The person's own orchestrator session, if they have one (Orchestrators.personalOf). */
  personalOf(userId: string): { id: string; status: string } | undefined;
  /** Remove a session: stops its process, drops it and its transcript (SessionManager.remove). */
  removeSession(id: string): void;
  /** The endpoints of the login's push subscriptions, and how to drop one (Notifier). */
  pushEndpoints(userId: string): string[];
  unsubscribe(endpoint: string): void;
  /** The memory root and the login's memory folder (memoryDirFor, not made). */
  memoryRoot: string;
  memoryDir(userId: string): string;
  now?: () => Date;
}

export interface LoginDeleteRequest {
  /** The login to delete, its exact id. */
  user: string;
  /** The login this is run as or for (the person who asked): never deleted by its own request. */
  by: string;
  /** Refuse an owner login (the orchestration worker's form: member logins only). */
  membersOnly?: boolean;
}

export interface LoginDeleted {
  user: string;
  displayName: string;
  role: string;
  /** Names of the API keys removed (never a key: only hashes are kept). */
  keys: string[];
  sessions: number;
  /** The pool entry removed: whose pool the login's work ran on, or undefined when it was "self". */
  pool?: string;
  /** Other per-login settings removed: heartbeat, dismissedEvents. */
  settings: string[];
  pushSubscriptions: number;
  /** The orchestrator session removed: its id and status before. */
  orchestrator?: { id: string; status: string };
  /** Memory files moved to the trash, and where. */
  memoryFiles: number;
  memoryTrash?: string;
}

/** Why `r` is refused, checked against the logins and settings now, or undefined. Nothing is touched. */
export function loginDeleteProblem(d: Pick<LoginDeleteDeps, 'auth' | 'settings'>, r: LoginDeleteRequest): string | undefined {
  if (typeof r.user !== 'string' || !LOGIN_ID.test(r.user)) return `not a login id: '${String(r.user).slice(0, 40)}' (2-32 letters, digits, . _ -)`;
  if (typeof r.by !== 'string' || !LOGIN_ID.test(r.by)) return `--by names the login this is run as (the person who asked): not '${String(r.by).slice(0, 40)}'`;
  const all = d.auth.userInfos();
  const info = all.find((u) => u.userId === r.user);
  if (!info) {
    const near = all.find((u) => same(u.userId, r.user));
    return near ? `'${r.user}' differs only in case from the login '${near.userId}': give its exact id` : `no login '${r.user}'`;
  }
  if (!all.some((u) => same(u.userId, r.by))) return `--by ${r.by}: no such login`;
  if (same(r.user, r.by)) return `'${r.user}' is the login this is run as: a login never deletes itself`;
  if (info.role === 'owner' && all.filter((u) => u.role === 'owner').length < 2) return `'${r.user}' is the last owner login: make another login an owner first`;
  if (r.membersOnly) {
    if (PROTECTED_LOGINS.includes(r.user.toLowerCase())) return `'${r.user}' is a person's own login: deleting it is a person's (sudo fffctl user delete)`;
    if (info.role !== 'member') return `'${r.user}' is an ${info.role} login: only member logins are deleted here (sudo fffctl user delete is a person's)`;
  }
  const leaning = Object.entries(d.settings().pool ?? {}).filter(([k, v]) => !same(k, r.user) && same(v, r.user)).map(([k]) => k);
  if (leaning.length) return `${leaning.join(', ')}'s pool setting names '${r.user}''s pool: set it back to self first (Settings), so deleting this login changes no other`;
  return undefined;
}

/** Delete the login and everything of its own, after loginDeleteProblem passes. Throws LoginDeleteRefused, untouched, when it does not. */
export function deleteLogin(d: LoginDeleteDeps, r: LoginDeleteRequest): LoginDeleted {
  const why = loginDeleteProblem(d, r);
  if (why) refuse(why);
  const info = d.auth.userInfos().find((u) => u.userId === r.user)!;
  // The orchestrator first: its process stops before the login it runs for goes.
  const orch = d.personalOf(r.user);
  if (orch) d.removeSession(orch.id);
  const { keys, sessions } = d.auth.deleteUser(r.user);

  const s = d.settings();
  const patch: Partial<AppSettings> = {};
  const settings: string[] = [];
  const poolKey = Object.keys(s.pool ?? {}).find((k) => same(k, r.user));
  if (poolKey) patch.pool = Object.fromEntries(Object.entries(s.pool!).filter(([k]) => k !== poolKey));
  for (const name of ['heartbeat', 'dismissedEvents'] as const) {
    const m = s[name] as Record<string, unknown> | undefined;
    const k = Object.keys(m ?? {}).find((x) => same(x, r.user));
    if (!k) continue;
    (patch as Record<string, unknown>)[name] = Object.fromEntries(Object.entries(m!).filter(([x]) => x !== k));
    settings.push(name);
  }
  if (Object.keys(patch).length) d.putSettings(patch);

  const push = d.pushEndpoints(r.user);
  for (const e of push) d.unsubscribe(e);

  const { files, trash } = trashMemory(d.memoryRoot, d.memoryDir(r.user), (d.now ?? (() => new Date()))());
  const out: LoginDeleted = {
    user: r.user,
    displayName: info.displayName,
    role: info.role,
    keys,
    sessions,
    ...(poolKey ? { pool: s.pool![poolKey] } : {}),
    settings,
    pushSubscriptions: push.length,
    ...(orch ? { orchestrator: { id: orch.id, status: orch.status } } : {}),
    memoryFiles: files,
    ...(trash ? { memoryTrash: trash } : {}),
  };
  console.log(`login deleted (w1864): ${describeLoginDeleted(out).join('; ')}; asked by ${r.by}`);
  return out;
}

/**
 * Move every file of a memory folder into the memory trash (<root>.backup/trash/<folder>/<stamp>-<path>, pruned after
 * MEMORY_TRASH_DAYS days by the time in its name), then remove the folder. A file in a sub-folder keeps its path with
 * "__" for each separator.
 */
function trashMemory(root: string, dir: string, now: Date): { files: number; trash?: string } {
  if (!fs.existsSync(dir)) return { files: 0 };
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const trash = memoryTrashDir(root, path.basename(dir));
  let files = 0;
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        fs.mkdirSync(trash, { recursive: true });
        let kept = path.join(trash, `${stamp}-deleted-login-${r.replaceAll('/', '__')}`);
        for (let i = 2; fs.existsSync(kept); i++) kept = path.join(trash, `${stamp}-${i}-deleted-login-${r.replaceAll('/', '__')}`);
        fs.copyFileSync(path.join(dir, r), kept);
        files++;
      }
    }
  };
  walk('');
  fs.rmSync(dir, { recursive: true, force: true });
  return { files, ...(files ? { trash } : {}) };
}

/** The lines `fffctl user delete` prints: what went, never a secret. */
export function describeLoginDeleted(r: LoginDeleted): string[] {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  return [
    `deleted the login ${r.user} ("${r.displayName}", ${r.role})`,
    `API keys: ${r.keys.length ? r.keys.join(', ') : 'none'}`,
    `sessions ended: ${r.sessions}`,
    `pool entry: ${r.pool ? `removed (its work ran on ${r.pool}'s pool)` : 'none (self)'}`,
    `other settings: ${r.settings.length ? r.settings.join(', ') : 'none'}`,
    `push subscriptions: ${r.pushSubscriptions}`,
    `orchestrator: ${r.orchestrator ? `session ${r.orchestrator.id} removed, its process stopped (was ${r.orchestrator.status})` : 'none'}`,
    `orchestrator memory: ${r.memoryFiles ? `${n(r.memoryFiles, 'file')} moved to ${r.memoryTrash}` : 'none'}`,
  ];
}

// ---------------------------------------------------------------- the hand-off between fffctl and the portal

/** data/login-delete/: <id>.json is a request (LoginDeleteRequest), <id>.result.json the portal's answer. */
export const LOGIN_DELETE_DIR = 'login-delete';
export const REQUEST_ID = /^[a-z0-9-]{8,64}$/;

export type LoginDeleteAnswer = { ok: true; deleted: LoginDeleted; lines: string[] } | { ok: false; error: string };

/** Answer every request waiting in `dataDir`/login-delete (the portal's 1 s poll). A request is read once, then removed. */
export function serveLoginDeletes(dataDir: string, run: (r: LoginDeleteRequest) => LoginDeleted): number {
  const dir = path.join(dataDir, LOGIN_DELETE_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let served = 0;
  for (const name of names.sort()) {
    const m = /^(.+)\.json$/.exec(name);
    if (!m || name.endsWith('.result.json') || !REQUEST_ID.test(m[1])) continue;
    const file = path.join(dir, name);
    let req: LoginDeleteRequest;
    try {
      req = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // being written (the CLI renames it in whole, so this is rare); next tick
    }
    fs.rmSync(file, { force: true });
    let answer: LoginDeleteAnswer;
    try {
      const deleted = run({ user: req?.user, by: req?.by, ...(req?.membersOnly === true ? { membersOnly: true } : {}) });
      answer = { ok: true, deleted, lines: describeLoginDeleted(deleted) };
    } catch (e) {
      answer = { ok: false, error: e instanceof LoginDeleteRefused ? e.message : `failed: ${(e as Error).message}` };
    }
    const out = path.join(dir, `${m[1]}.result.json`);
    fs.writeFileSync(`${out}.tmp`, JSON.stringify(answer, null, 2), { mode: 0o600 });
    fs.renameSync(`${out}.tmp`, out);
    served++;
  }
  return served;
}
