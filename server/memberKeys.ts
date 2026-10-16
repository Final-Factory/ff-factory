// API keys for member logins, minted by the orchestration worker (w1415, docs/ops-worker.md "API keys for a member login"):
// `fffctl apikey ...` runs server/memberKeyCli.ts on these. A key is written to a file (0600), never returned to print:
// the caller sees its last four characters. Only member logins: never an owner, never Ben's or Lothsahn's own, never a key
// that acts for the owner or has a scope (those stay `node server/apikey.ts`, a person's).
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Auth } from './auth.ts';

/**
 * The logins no key from here may act for, whatever their role says (w1415, Ben: refuse binding to Ben's or Lothsahn's
 * user ids). opsWorker.ts's OPS_PEOPLE are the same people; memberKeys.test.ts checks it.
 */
export const PROTECTED_LOGINS: readonly string[] = ['ben', 'lothsahn'];

export const LOGIN_ID = /^[a-zA-Z0-9._-]{2,32}$/;
export const KEY_NAME = /^[a-zA-Z0-9._-]{2,40}$/;

export class MemberKeyRefused extends Error {}
const refuse = (msg: string): never => {
  throw new MemberKeyRefused(msg);
};

/** Why `user` may not have a key from here, or undefined. `create`: the login may not exist yet. */
function loginProblem(auth: Auth, user: string, create: boolean): string | undefined {
  if (!LOGIN_ID.test(user)) return `not a login id: '${user.slice(0, 40)}' (2-32 letters, digits, . _ -)`;
  if (PROTECTED_LOGINS.includes(user.toLowerCase())) return `'${user}' is ${user.toLowerCase() === 'ben' ? "Ben's" : "Lothsahn's"} own login: a key for it is a person's, never the orchestration worker's`;
  const info = auth.userInfo(user) ?? auth.userInfos().find((u) => u.userId.toLowerCase() === user.toLowerCase());
  if (info && info.userId !== user) return `'${user}' differs only in case from the login '${info.userId}': give its exact id`;
  if (info && info.role !== 'member') return `'${user}' is an ${info.role} login: only member logins get a key here (an owner's key is a person's: node server/apikey.ts)`;
  if (!info && !create) return `no login '${user}': add --create-member to make it a member login with a random password nobody sees`;
  return undefined;
}

export interface IssueOptions {
  /** The key's name (api-keys.json): re-issuing a name replaces its key. */
  name: string;
  /** The member login the key acts for (work it starts is requested by them). */
  user: string;
  /** Make the login if it is missing: role member, a random password that is never shown or stored in clear. */
  createMember?: boolean;
  /** The new login's display name (default its id). Only with createMember, for a login that does not exist yet. */
  displayName?: string;
  /** Where the key goes (0600, a new file). */
  out: string;
}

export interface Issued {
  last4: string;
  createdLogin: boolean;
  /** An older key of the same name, for the same login, that this one replaced. */
  replaced: boolean;
}

/** Mint a key for a member login into `out` (0600). Everything is checked before anything is written. */
export async function issueMemberKey(auth: Auth, o: IssueOptions): Promise<Issued> {
  if (!KEY_NAME.test(o.name)) refuse(`not a key name: '${o.name.slice(0, 50)}' (2-40 letters, digits, . _ -)`);
  const why = loginProblem(auth, o.user, !!o.createMember);
  if (why) refuse(why);
  const exists = !!auth.userInfo(o.user);
  if (o.displayName !== undefined && (exists || !o.createMember)) refuse(`--display-name names a new login (with --create-member); '${o.user}' ${exists ? 'exists' : 'is not being made'}`);
  const old = auth.apiKeyInfos().find((k) => k.name === o.name);
  if (old && (old.user !== o.user || old.scope)) refuse(`a key named '${o.name}' exists and acts for ${old.user ? `'${old.user}'` : 'the owner'}${old.scope ? ` (scope ${old.scope})` : ''}: re-issuing it would replace that key. Pick another name`);
  if (fs.existsSync(o.out)) refuse(`${o.out} exists; pick a new file`);
  let createdLogin = false;
  if (!exists) {
    // 32 random bytes: nobody logs in with it; the key is what this login is for. Only its scrypt hash is kept.
    await auth.setUser(o.user, randomBytes(32).toString('base64url'), { role: 'member', ...(o.displayName !== undefined ? { displayName: o.displayName } : {}) });
    createdLogin = true;
  }
  const key = auth.createApiKey(o.name, o.user);
  try {
    fs.writeFileSync(o.out, `${key}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(o.out, 0o600);
  } catch (e) {
    auth.revokeApiKey(o.name); // a key nobody holds would only be one more way in
    throw e;
  }
  return { last4: key.slice(-4), createdLogin, replaced: !!old };
}

/** Revoke a key that acts for a member login (never an owner's, a scoped one or Ben's or Lothsahn's). Returns its login. */
export function revokeMemberKey(auth: Auth, name: string): string {
  if (!KEY_NAME.test(name)) refuse(`not a key name: '${name.slice(0, 50)}'`);
  const k = auth.apiKeyInfos().find((x) => x.name === name) ?? refuse(`no key named '${name}'`);
  const theirs = "revoking it is a person's (node server/apikey.ts --revoke)";
  if (k.scope) return refuse(`the key '${name}' has scope ${k.scope}: ${theirs}`);
  if (!k.user) return refuse(`the key '${name}' acts for the owner: ${theirs}`);
  const why = loginProblem(auth, k.user, false);
  if (why) refuse(`the key '${name}' acts for '${k.user}': ${why}`);
  auth.revokeApiKey(name);
  return k.user;
}

/** The keys that act for member logins: name, login, when made. No hash, no value. */
export function memberKeys(auth: Auth) {
  const members = new Set(auth.userInfos().filter((u) => u.role === 'member').map((u) => u.userId));
  return auth.apiKeyInfos().filter((k) => k.user && !k.scope && members.has(k.user) && !PROTECTED_LOGINS.includes(k.user.toLowerCase()));
}
