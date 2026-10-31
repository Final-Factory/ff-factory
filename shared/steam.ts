// Each machine's Steam client: installed, running, signed in, as which account (w2459, docs/machines.md "The machine's Steam
// client"). w2458, the pair run for the lobby-browser PR #2757, put its client leg on biscuit, which has no Steam client, and
// died at its Steam check; w2452 died with Steam signed out. The daemon reads the client's own state cheaply
// (machine/steamClient.ts: on Windows the HKCU\Software\Valve\Steam keys and a steam.exe process check, elsewhere Steam's
// registry.vdf and pgrep) and reports the account id and display name only; a pair run that needs Steam (WorkPair.steam)
// goes only on computers signed in to Steam, a different account on each leg (shared/capacity.ts pairRoom). The login name
// (loginusers.vdf AccountName, half of a credential) is never read out of the file. Pure, shared by the daemon and the portal.
import { affirmedMention } from './mentions.ts';

/** What a daemon reports of its machine's Steam client (FromDaemon `steam_client`). */
export interface SteamClient {
  /** When the daemon last read it (ISO). */
  checkedAt: string;
  /** A Steam client is installed for the daemon's user. */
  installed: boolean;
  /** Its process runs. */
  running: boolean;
  /** The signed-in account's 32-bit account id (Steam's ActiveUser, the low half of its SteamID64); none when signed out. */
  accountId?: number;
  /** Its display name (loginusers.vdf PersonaName): "Lothsahn", "slims". */
  persona?: string;
  /** The account is set to start in offline mode, where Steam lobbies do not work. */
  offline?: boolean;
  /**
   * Signed in but not connected to Steam's servers, as its logs/connection_log.txt last says (steamConnection): lobbies
   * need the connection. w2461 (2026-10-28): BEAST's Steam ran with its account set, but had been logged off since
   * 2026-10-25 ('Logged In Elsewhere') and every sign-in since failed ('Try another CM').
   */
  notConnected?: string;
  /** Why it could not be read, in FF Factory's own words. */
  error?: string;
}

/** SteamID64 of account id 0 in the public universe: SteamID64 = this + accountId. */
export const STEAM_ID64_BASE = 76561197960265728n;

const PERSONA = 64;
const ERRORS = 160;

/** The report as the portal keeps it, or undefined when it is not one: the account id and a display name, nothing else. */
export function sanitizeSteamClient(raw: unknown): SteamClient | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const checkedAt = typeof r.checkedAt === 'string' && !Number.isNaN(Date.parse(r.checkedAt)) ? new Date(r.checkedAt).toISOString() : undefined;
  if (!checkedAt) return undefined;
  const accountId = typeof r.accountId === 'number' && Number.isInteger(r.accountId) && r.accountId > 0 && r.accountId < 2 ** 32 ? r.accountId : undefined;
  const persona = typeof r.persona === 'string' ? cleanText(r.persona, PERSONA) || undefined : undefined;
  const error = typeof r.error === 'string' ? cleanText(r.error, ERRORS) || undefined : undefined;
  return {
    checkedAt,
    installed: r.installed === true,
    running: r.running === true,
    ...(accountId ? { accountId } : {}),
    ...(persona ? { persona } : {}),
    ...(r.offline === true ? { offline: true } : {}),
    ...(typeof r.notConnected === 'string' && cleanText(r.notConnected, ERRORS) ? { notConnected: cleanText(r.notConnected, ERRORS) } : {}),
    ...(error ? { error } : {}),
  };
}

function cleanText(text: string, max: number): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Signed in and online: what a Steam lobby needs. */
export const steamSignedIn = (s: SteamClient | undefined): s is SteamClient & { accountId: number } => !!s?.installed && s.running && !!s.accountId && !s.offline && !s.notConnected;

/** Why computer `id` cannot run a leg that needs Steam, or undefined when it can: "biscuit has no Steam client installed". */
export function steamLacks(id: string, s: SteamClient | undefined): string | undefined {
  if (!s) return `${id}'s daemon has not reported its Steam client yet`;
  if (s.error && !s.installed) return `${id}'s Steam client could not be read (${s.error})`;
  if (!s.installed) return `${id} has no Steam client installed`;
  if (!s.running) return `${id}'s Steam client is not running`;
  if (!s.accountId) return `${id}'s Steam client is signed out${s.error ? ` (${s.error})` : ''}`;
  if (s.offline) return `${id}'s Steam client is in offline mode${s.persona ? ` (${s.persona})` : ''}`;
  if (s.notConnected) return `${id}'s Steam client${s.persona ? ` (${s.persona})` : ''} is not connected to Steam: ${s.notConnected}`;
  return undefined;
}

/** "Lothsahn (signed in)", "not installed", "signed out", "not reported yet (an older daemon)". */
export function steamLabel(s: SteamClient | undefined): string {
  if (!s) return 'not reported yet (an older daemon)';
  if (!s.installed) return s.error ? `unknown (${s.error})` : 'not installed';
  if (!s.running) return 'installed, not running';
  if (!s.accountId) return `running, signed out${s.error ? ` (${s.error})` : ''}`;
  return `${s.persona ?? `account ${s.accountId}`} (signed in${s.offline ? ', offline mode: no lobbies' : ''}${s.notConnected ? `, not connected: ${s.notConnected}` : ''})`;
}

/** The account's name as lines about a pair run say it: its display name, else its account id. */
export const steamAccountText = (s: SteamClient & { accountId: number }): string => s.persona ? `"${s.persona}"` : `account ${s.accountId}`;

/** A Valve KeyValues (VDF) text as nested objects; keys keep their case. Tolerant: what it cannot read it skips. */
export type Vdf = { [key: string]: string | Vdf };
export function parseVdf(text: string): Vdf {
  const tokens: (string | '{' | '}')[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])|\/\/[^\n]*|([^\s"{}]+)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m[1] !== undefined) tokens.push(m[1].replace(/\\(.)/g, '$1'));
    else if (m[2]) tokens.push(m[2] as '{' | '}');
    else if (m[3]) tokens.push(m[3]);
  }
  let i = 0;
  const block = (): Vdf => {
    const out: Vdf = {};
    while (i < tokens.length) {
      const k = tokens[i++];
      if (k === '}') return out;
      if (k === '{') continue;
      const v = tokens[i++];
      if (v === '{') out[k] = block();
      else if (v !== undefined && v !== '}') out[k] = v;
      else return out;
    }
    return out;
  };
  return block();
}

/** A key of `o`, case-blind (Steam writes "ActiveUser" in one file and "activeuser" in another). */
export function vdfGet(o: string | Vdf | undefined, ...path: string[]): string | Vdf | undefined {
  let cur: string | Vdf | undefined = o;
  for (const p of path) {
    if (!cur || typeof cur === 'string') return undefined;
    const k = Object.keys(cur).find((x) => x.toLowerCase() === p.toLowerCase());
    cur = k === undefined ? undefined : cur[k];
  }
  return cur;
}

/** Of loginusers.vdf, the signed-in account's display name and offline-mode setting; never its login name. */
export function loginUserOf(text: string, accountId: number): { persona?: string; offline?: boolean } {
  const users = vdfGet(parseVdf(text), 'users');
  const u = vdfGet(users, String(STEAM_ID64_BASE + BigInt(accountId)));
  if (!u || typeof u === 'string') return {};
  const persona = vdfGet(u, 'PersonaName');
  const offline = vdfGet(u, 'WantsOfflineMode');
  return { ...(typeof persona === 'string' && persona ? { persona } : {}), ...(offline === '1' ? { offline: true } : {}) };
}

/**
 * Words that say a pair run needs Steam (lobbies, a Steam host or join): what request_pair reads from its what and brief
 * when the worker does not say. A wrong yes only keeps its legs to computers signed in to Steam; steam: false says no. A bare
 * "Steam" is not enough: a determinism pair names "the Steam development branch" and joins over a direct address.
 */
const STEAM_WORDS: readonly RegExp[] = [
  /\blobb(?:y|ies)\b/i,
  /\bsteam[- ]?(?:online|lobb|join|host|invite|friend|matchmak|networking|relay|p2p|account|sign|log(?:ged|in))/i,
  /\bSteam(?:Matchmaking|Networking|Friends|Client)\b/,
  /\bsigned (?:in|out) (?:of|to) steam\b/i,
];
export const mentionsSteam = (...texts: (string | undefined)[]): boolean => texts.some((t) => !!t && STEAM_WORDS.some((re) => affirmedMention(t, re)));

/**
 * Whether the client is connected to Steam's servers, from the tail of its logs/connection_log.txt (w2461): undefined when
 * its last state is Logged On after its last log-off, else why not ("logged off at 2026-10-25 14:03:15 (Logged In
 * Elsewhere); 9 sign-ins failed since, the last at 2026-10-28 02:59:11 ('Try another CM')"). No log or no state line: undefined.
 */
export function steamConnection(tail: string): string | undefined {
  let state: string | undefined;
  let off: string | undefined;
  let fails = 0;
  let lastFail: string | undefined;
  for (const line of tail.split(/\r?\n/)) {
    const m = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] \[([A-Za-z ]+), \d+, \d+\]/.exec(line);
    if (!m) continue;
    state = m[2];
    const r = /RecvMsgClientLogOnResponse\(\) : (?:\[[^\]]*\] )?'([^']+)'/.exec(line);
    if (r && r[1] === 'OK') { off = undefined; fails = 0; lastFail = undefined; continue; }
    if (r) { fails++; lastFail = `${m[1]} ('${r[1]}')`; continue; }
    const lo = /RecvMsgClientLoggedOff\('([^']+)'\)/.exec(line);
    if (lo) { off = `logged off at ${m[1]} (${lo[1]})`; fails = 0; lastFail = undefined; }
  }
  if (!state) return undefined;
  if (state === 'Logged On' && !off && !fails) return undefined;
  const failed = fails ? `${fails} sign-in${fails > 1 ? 's' : ''} failed${off ? ' since' : ''}, the last at ${lastFail}` : '';
  return [off, failed].filter(Boolean).join('; ') || `its connection is ${state}`;
}

/** Why a pair run needs Steam when its words said so and its filer did not (WorkPair.steam). */
export const STEAM_READ = 'read from its words: a lobby or a Steam host or join; request_pair steam "none" says it needs none';
