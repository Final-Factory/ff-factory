// Who asked for a piece of work (docs/identity.md). Every person's message is recorded with its author, and
// everything it causes (orchestrator tool calls, workers, standing runs, delegation approvals) carries that
// person as `requestedBy`, so work can be billed to the right Claude account: here (config userClaudeEnv) and
// on FFBox (docs/ffbox-connector-contract.md, the `requestedBy` of a work message).
import type { Config } from './config.ts';
import type { Requester, TranscriptEvent, UserInfo } from '../shared/types.ts';

/** A login name, which is also the user id: what auth.ts accepts. */
export const USER_ID = /^[a-zA-Z0-9._-]{2,32}$/;

/** Only the two fields, whatever else the object carries (a UserInfo's role stays out of transcripts). */
export const asRequester = (u: Requester): Requester => ({ userId: u.userId, displayName: u.displayName });

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The people this portal knows, and who pays for work nobody asked for. */
export class Identity {
  private readonly cfg: Pick<Config, 'systemPayer' | 'ownerName'>;
  private readonly users: () => UserInfo[];

  constructor(cfg: Pick<Config, 'systemPayer' | 'ownerName'>, users: () => UserInfo[]) {
    this.cfg = cfg;
    this.users = users;
  }

  list(): UserInfo[] {
    try {
      return this.users();
    } catch {
      return [];
    }
  }

  get(userId: string): UserInfo | undefined {
    return this.list().find((u) => same(u.userId, userId));
  }

  /** The requester for a login name, or undefined when there is no such login. */
  requester(userId: string | undefined): Requester | undefined {
    const u = userId ? this.get(userId) : undefined;
    return u ? asRequester(u) : undefined;
  }

  /** The portal's owner: the first login with the owner role, else the first login, else config ownerName. */
  owner(): Requester {
    const all = this.list();
    const u = all.find((x) => x.role === 'owner') ?? all[0];
    if (u) return asRequester(u);
    const name = this.cfg.ownerName?.trim();
    return { userId: 'owner', displayName: name || 'Owner' };
  }

  /**
   * Who automatic work is attributed and billed to: scheduled standing-agent runs, and (phase 4) intake-triggered
   * FFBox diagnoses. Config `systemPayer` (a user id; Ben, per his decision), else the owner. A systemPayer that
   * names no login falls back to the owner, so a typo never makes work anonymous.
   */
  systemPayer(): Requester {
    return this.requester(this.cfg.systemPayer) ?? this.owner();
  }
}

/**
 * Who a tool call acts for, in a session several people write to (the shared orchestrator chat).
 *
 * By default the author of the latest message a person wrote (`latest`), else `fallback`. `forUser` overrides
 * it, but only with someone the recent transcript shows asking for something: a person who wrote a message, or
 * one a [worker update] was for. So the orchestrator can attribute a follow-up to the person whose request it
 * serves when two people's messages interleave, and text an agent wrote cannot bill a stranger.
 */
export function actingFor(recent: readonly TranscriptEvent[], latest: Requester | undefined, forUser: string | undefined, fallback: Requester): Requester {
  if (!forUser) return latest ?? fallback;
  const known = new Map<string, Requester>();
  for (const e of recent) if (e.kind === 'user' && e.requestedBy) known.set(e.requestedBy.userId.toLowerCase(), asRequester(e.requestedBy));
  if (latest) known.set(latest.userId.toLowerCase(), asRequester(latest));
  const hit = known.get(forUser.trim().toLowerCase());
  if (hit) return hit;
  const names = [...known.values()].map((r) => r.userId);
  throw new Error(`for_user "${forUser}" has not asked for anything in this conversation recently${names.length ? `; it can be ${names.join(' or ')}` : ''}. Leave it out to act for the latest message's author.`);
}

/** "for Lothsahn" on a line about a piece of work; '' when nobody is known. */
export const forLine = (r: Requester | undefined) => (r ? ` (requested by ${r.displayName})` : '');

/**
 * The Claude env an agent working for `who` runs with: `base` (the owner's: what config claudeAccounts picks on
 * this host, or for a Mac what it takes of config claudeEnv) with that person's own entry in config
 * userClaudeEnv laid over it. A person with no entry runs on `base`: the owner's account. docs/identity.md,
 * "Local billing", and docs/accounts.md.
 */
export function claudeEnvFor<E extends Record<string, string | undefined>>(cfg: Pick<Config, 'userClaudeEnv'>, who: Requester | undefined, base: E): E {
  const own = who ? Object.entries(cfg.userClaudeEnv ?? {}).find(([id]) => same(id, who.userId))?.[1] : undefined;
  return own && Object.keys(own).length ? { ...base, ...own } : base;
}

/** The OAuth token config userClaudeEnv gives `userId`, if any. */
export function userToken(cfg: Pick<Config, 'userClaudeEnv'>, userId: string | undefined): string | undefined {
  if (!userId) return undefined;
  return Object.entries(cfg.userClaudeEnv ?? {}).find(([id]) => same(id, userId))?.[1]?.CLAUDE_CODE_OAUTH_TOKEN || undefined;
}
