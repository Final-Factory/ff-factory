// "Start Steam in the desktop session" (w6727, docs/machines.md "Starting the Steam client"): one narrow, named operation of
// the Windows daemon, and nothing else. lothsahn (2026-11-27): "Great.  Do it", as a lasting capability on every Windows
// machine, then "I would like self healing as much as possible if it doesn't cause a security or safety problem".
//
// Why the daemon: workers run at Low, and a Steam started at Low stops at its "registry not writable, Repair?" dialog; ssh
// lands in session 0 at High, off the desktop. The daemon runs at Medium as the desktop user in that user's session, so it
// is the one place a Steam can be started the way a person's double-click starts it.
//
// What it does, and all it does:
// - the exe comes from Steam's own install record only (HKCU\Software\Valve\Steam SteamExe, else SteamPath\steam.exe), must
//   be named steam.exe and exist; no caller names a path, an argument or any other field (steamStartMsgProblem);
// - it refuses unless the daemon runs at Medium (never Low, which would hit the Repair dialog; never High or System), in an
//   interactive session (not session 0), which Windows' own quser shows as the daemon's own user's logged-in session;
// - Steam already running: it does nothing and says so;
// - it hands the exe to that session's Explorer (`explorer.exe <steam.exe>`), which starts it as the shell starts a
//   double-clicked program: at Medium, in the user's session, with the user's own environment and outside the daemon's
//   scheduled-task job (FFFactoryDaemon). With no Explorer running in the session (it had crashed on BEAST, 2026-11-27),
//   the daemon starts the exe itself, detached, the way it starts a Unity editor: in Steam's own folder, with the daemon's
//   environment less FF Factory's own variables and anything named like a credential. Steam gets no arguments either way;
// - it waits, bounded, for steam.exe and its sign-in, and says what it saw: signed in as whom, connected or not, and any
//   window title of Steam's or a crash reporter that is up (read with tasklist /V, never clicked: never press Repair).
// Nothing is written anywhere: no scheduled task, service, registry value or file.
//
// Self-healing (SteamStarter.beforePlayer): a players broker launch on Windows finds Steam installed but not running, and
// starts it the same way before the player, within the launch's own time (the game repo's broker_start waits 120 s). Bounded:
// one start at a time (callers share it), automatic tries back off (2, 10, 30 min after each failure) and stop at 4 in 6 h
// until Steam is seen running again; every try is logged. A try that leaves Steam not running refuses that launch with a
// clear error; a launch that cannot try (no desktop user, Steam not installed, backing off) starts the player as before.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readSteamClient, regValue, realSteamDeps, type SteamClientDeps } from './steamClient.ts';
import type { SteamClient } from '../shared/steam.ts';

export interface SteamStartDeps extends SteamClientDeps {
  sleep: (ms: number) => Promise<void>;
  /** The daemon's own pid, whose session the desktop must be. */
  pid: number;
  /** The daemon's own user name (os.userInfo().username), who must own that session's Explorer. */
  user: string;
  /** Windows' folder (SystemRoot), where explorer.exe, whoami.exe and quser.exe live. */
  systemRoot: string;
  /** Start exe detached with no arguments in cwd (when no Explorer runs in the session); rejects if it cannot. */
  spawnDetached: (exe: string, cwd: string) => Promise<number>;
  log: (line: string) => void;
}

export const realSteamStartDeps = (log: (line: string) => void): SteamStartDeps => ({
  ...realSteamDeps(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  pid: process.pid,
  user: os.userInfo().username,
  systemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
  spawnDetached: (exe, cwd) =>
    new Promise<number>((resolve, reject) => {
      const c = spawn(exe, [], { cwd, env: steamEnv(process.env), detached: true, stdio: 'ignore', windowsHide: false });
      c.once('error', reject);
      c.once('spawn', () => {
        c.unref();
        resolve(c.pid ?? 0);
      });
    }),
  log,
});

/** The environment a directly started Steam gets: the daemon's, less FF Factory's own variables and credential-like ones. */
export function steamEnv(e: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(e)) {
    if (v !== undefined && !/^(FF|FFW|FFSB|CLAUDE|ANTHROPIC|GH|GITHUB|NODE|AWS)_|TOKEN|SECRET|PASSW|CREDENTIAL|_?KEY(_|$)|PRIVATE|_PAT$|AUTH/i.test(k)) out[k] = v;
  }
  return out;
}

export type SteamStartState = 'already' | 'started' | 'refused' | 'failed';
export interface SteamStartResult {
  state: SteamStartState;
  /** What happened, in plain words, for the caller and the daemon log. */
  said: string;
  client?: SteamClient;
}

/** The only fields a steam_start message carries. Anything else (a path, arguments, an exe, a cwd) is refused. */
const MSG_FIELDS = new Set(['type', 'id', 'why']);

/** Why a steam_start message is refused, or undefined: it may name no path, no arguments and no other field. */
export function steamStartMsgProblem(msg: Record<string, unknown>): string | undefined {
  const extra = Object.keys(msg).filter((k) => !MSG_FIELDS.has(k));
  if (extra.length) return `steam_start takes no ${extra.slice(0, 4).join(', ')}: it starts only the installed Steam client, found from Steam's own install record, with no arguments`;
  if (msg.why !== undefined && (typeof msg.why !== 'string' || msg.why.length > 300)) return 'steam_start: why is a short text';
  return undefined;
}

const RUN = { timeoutMs: 15_000 };
/** Windows' own tools by their full paths (never whatever PATH names first). */
const sys32 = (d: Pick<SteamStartDeps, 'systemRoot'>, exe: string) => path.win32.join(d.systemRoot, 'System32', exe);
/** How long the person's operation waits for Steam to come up and sign in (the portal waits 4 min for the answer). */
export const MANUAL_WAIT_MS = 120_000;
/** How long a player launch waits for it: inside the broker's 120 s, with the Low launch after it (up to 60 s). */
export const AUTO_WAIT_MS = 45_000;
/** Poll period while waiting. */
const POLL_MS = 3_000;
/** A started Steam whose process has not shown in this long is handed to Explorer once more (at most twice per start). */
const RELAUNCH_AFTER_MS = 20_000;
/** Automatic tries: the wait before the next one after 1, 2, 3 failures in a row, and at most this many in WINDOW_MS. */
export const AUTO_BACKOFF_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000];
export const AUTO_MAX = 4;
export const AUTO_WINDOW_MS = 6 * 60 * 60_000;

/** One CSV row of tasklist /FO CSV: its quoted fields. */
export function csvFields(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
}
const rows = (out: string) => out.split(/\r?\n/).filter((l) => l.startsWith('"')).map(csvFields);

/** Steam's installed client exe from its own install record, or why there is none. Never a caller's path. */
export async function resolveSteamExe(d: Pick<SteamStartDeps, 'run' | 'exists' | 'systemRoot'>): Promise<{ exe: string } | { missing: string }> {
  const r = await d.run(sys32(d, 'reg.exe'), ['query', 'HKCU\\Software\\Valve\\Steam'], RUN);
  if (r.code !== 0) return { missing: 'Steam is not installed for this user (no HKCU\\Software\\Valve\\Steam)' };
  const fromExe = regValue(r.stdout, 'SteamExe');
  const fromPath = regValue(r.stdout, 'SteamPath');
  for (const cand of [fromExe, fromPath ? `${fromPath}/steam.exe` : undefined]) {
    if (!cand) continue;
    const exe = path.win32.normalize(cand.replace(/^"|"$/g, ''));
    if (!/^[a-z]:\\/i.test(exe) || path.win32.basename(exe).toLowerCase() !== 'steam.exe') continue;
    if (d.exists(exe)) return { exe };
  }
  return { missing: "Steam's install record names no steam.exe that exists" };
}

/** Whether steam.exe runs (any session). */
export async function steamRunning(d: Pick<SteamStartDeps, 'run' | 'systemRoot'>): Promise<boolean> {
  const t = await d.run(sys32(d, 'tasklist.exe'), ['/FI', 'IMAGENAME eq steam.exe', '/NH', '/FO', 'CSV'], RUN);
  return /^"steam\.exe"/im.test(t.stdout);
}

/** quser's rows: user, session id and state (Active, or Disc: logged in, its remote desktop disconnected). */
export function quserRows(out: string): { user: string; id: number; state: string }[] {
  const found: { user: string; id: number; state: string }[] = [];
  for (const l of out.split(/\r?\n/)) {
    const m = /^[ >](\S+)\s+(?:\S+\s+)?(\d+)\s+(Active|Disc)\b/i.exec(l);
    if (m) found.push({ user: m[1], id: Number(m[2]), state: m[3] });
  }
  return found;
}

/**
 * The logged-in desktop user, checked from the daemon's own process: its integrity is Medium, its session is not 0, and
 * Windows' quser shows that session as the daemon's own user's, logged in. Anything unread or unexpected refuses (fails
 * closed). Also says whether that session has an Explorer shell of the user's (the launch route) and whether it is locked.
 */
export async function desktopCheck(d: Pick<SteamStartDeps, 'run' | 'pid' | 'user' | 'systemRoot'>): Promise<{ session: number; locked: boolean; shell: boolean } | { refused: string }> {
  // Windows' own whoami and quser by their full paths: Git for Windows puts a coreutils whoami on PATH that knows no /groups.
  const who = await d.run(sys32(d, 'whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], RUN);
  const level = /Mandatory Label\\([A-Za-z ]+?) Mandatory Level/.exec(who.stdout)?.[1];
  if (!level) return { refused: "the daemon's integrity level could not be read (whoami /groups), so Steam is not started" };
  if (level === 'Low') return { refused: 'the daemon runs at Low integrity, where Steam stops at its "registry not writable" dialog; Steam is started only at Medium' };
  if (level !== 'Medium') return { refused: `the daemon runs at ${level} integrity; Steam is started only at Medium, as the desktop user, never elevated` };
  const me = rows((await d.run(sys32(d, 'tasklist.exe'), ['/FI', `PID eq ${d.pid}`, '/NH', '/FO', 'CSV'], RUN)).stdout)[0];
  const session = me ? Number(me[3]) : NaN;
  if (!Number.isInteger(session)) return { refused: "the daemon's own session could not be read (tasklist), so Steam is not started" };
  if (session === 0) return { refused: 'the daemon runs in session 0 (a service session), not on a desktop: no user is logged in on the desktop for it' };
  const mine = (u: string | undefined) => !!u && u.toLowerCase().split('\\').pop() === d.user.toLowerCase();
  // quser answers 1 with "No User exists" when nobody is logged in: its rows decide, not its exit code.
  const users = quserRows((await d.run(sys32(d, 'quser.exe'), [], RUN)).stdout).filter((u) => u.id === session);
  if (!users.length) return { refused: `no user is logged in on this computer's desktop (quser shows no logged-in session ${session}); Steam is started only in a logged-in desktop session` };
  if (!users.some((u) => mine(u.user))) return { refused: `the desktop in session ${session} is not ${d.user}'s; Steam is started only for the daemon's own logged-in user` };
  const shells = rows((await d.run(sys32(d, 'tasklist.exe'), ['/V', '/FI', 'IMAGENAME eq explorer.exe', '/FI', `SESSION eq ${session}`, '/NH', '/FO', 'CSV'], RUN)).stdout);
  const lock = await d.run(sys32(d, 'tasklist.exe'), ['/FI', 'IMAGENAME eq LogonUI.exe', '/FI', `SESSION eq ${session}`, '/NH', '/FO', 'CSV'], RUN);
  return { session, locked: /^"LogonUI\.exe"/im.test(lock.stdout), shell: shells.some((r) => mine(r[6])) };
}

/** Window titles of Steam and its crash reporter that are up (a dialog shows here), for the answer; never clicked. */
export async function steamWindows(d: Pick<SteamStartDeps, 'run' | 'systemRoot'>): Promise<string[]> {
  const out: string[] = [];
  for (const image of ['steam.exe', 'steamerrorreporter.exe']) {
    const t = await d.run(sys32(d, 'tasklist.exe'), ['/V', '/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'], RUN);
    for (const r of rows(t.stdout)) {
      const title = (r[8] ?? '').trim();
      if (image === 'steamerrorreporter.exe') out.push(`Steam's crash reporter is up${title && title !== 'N/A' ? ` ("${title.slice(0, 80)}")` : ''}`);
      else if (title && title !== 'N/A') out.push(`a Steam window "${title.slice(0, 80)}"`);
    }
  }
  return [...new Set(out)];
}

const signedIn = (c: SteamClient) => c.running && !!c.accountId;
const clientWords = (c: SteamClient) =>
  !c.running ? 'steam.exe is not running' : !c.accountId ? 'steam.exe runs but no account is signed in yet' : `signed in as ${c.persona ?? `account ${c.accountId}`}${c.offline ? ' (offline mode)' : ''}${c.notConnected ? `, not connected: ${c.notConnected}` : ', connected'}`;

/**
 * Start Steam once, as described at the top. Never throws: a failure is a result. `waitMs` bounds the wait for it to come
 * up and sign in. Every command is bounded (15 s, then killed): up to 8 run before the wait starts and a few after it, so
 * the whole call ends within waitMs plus about three minutes in the worst case (each command hanging to its limit).
 */
export async function startSteam(d: SteamStartDeps, o: { waitMs: number; why: string }): Promise<SteamStartResult> {
  try {
    if (d.platform !== 'win32') return { state: 'refused', said: 'starting Steam is a Windows daemon operation; this machine is not Windows' };
    const found = await resolveSteamExe(d);
    if ('missing' in found) return { state: 'refused', said: found.missing };
    if (await steamRunning(d)) {
      const client = await readSteamClient(d);
      return { state: 'already', said: `Steam is already running (${clientWords(client)}); nothing was done`, client };
    }
    const desk = await desktopCheck(d);
    if ('refused' in desk) return { state: 'refused', said: desk.refused };
    const explorer = path.win32.join(d.systemRoot, 'explorer.exe');
    const launch = async (n: number) => {
      const note = `${n > 1 ? ` (again, ${n})` : ''}${desk.locked ? '; the screen is locked, Steam starts behind it' : ''}`;
      if (desk.shell) {
        d.log(`steam start (${o.why}): handing ${found.exe} to the desktop's Explorer in session ${desk.session}${note}`);
        // explorer.exe answers 1 even when it started the program: whether Steam came up is read below, not from this.
        await d.run(explorer, [found.exe], RUN);
        return;
      }
      d.log(`steam start (${o.why}): no Explorer shell runs in session ${desk.session}; starting ${found.exe} directly, detached${note}`);
      try {
        await d.spawnDetached(found.exe, path.win32.dirname(found.exe));
      } catch (e) {
        d.log(`steam start (${o.why}): could not start ${found.exe}: ${(e as Error).message}`);
      }
    };
    const t0 = d.now().getTime();
    let launches = 1;
    await launch(launches);
    let seenRunning = false;
    let client: SteamClient = { checkedAt: d.now().toISOString(), installed: true, running: false };
    while (d.now().getTime() - t0 < o.waitMs) {
      await d.sleep(POLL_MS);
      client = await readSteamClient(d);
      if (client.running) seenRunning = true;
      if (signedIn(client) && !client.notConnected) break;
      if (!seenRunning && launches < 2 && d.now().getTime() - t0 >= RELAUNCH_AFTER_MS) await launch(++launches);
    }
    const windows = signedIn(client) && !client.notConnected ? [] : await steamWindows(d);
    const seen = windows.length ? `; up now: ${windows.join('; ')} (left for a person: never press Repair)` : '';
    const secs = Math.round((d.now().getTime() - t0) / 1000);
    if (!client.running) return { state: 'failed', said: `Steam did not start: after ${launches} start(s) and ${secs} s ${clientWords(client)}${seen}`, client };
    return { state: 'started', said: `Steam started in session ${desk.session} (${secs} s): ${clientWords(client)}${seen}`, client };
  } catch (e) {
    return { state: 'failed', said: `starting Steam failed: ${(e as Error).message}`.slice(0, 300) };
  }
}

/**
 * The daemon's one Steam starter: the person's named operation (manual) and the players broker's self-healing
 * (beforePlayer) share it, so there is one start at a time, and the automatic tries are bounded.
 */
export class SteamStarter {
  private inFlight?: Promise<SteamStartResult>;
  /** Automatic tries in the window (start times), the failures in a row, and when the next may run. */
  private autoTries: number[] = [];
  private autoFailures = 0;
  private autoNextAt = 0;
  private readonly d: SteamStartDeps;

  constructor(d: SteamStartDeps) {
    this.d = d;
  }

  private once(waitMs: number, why: string): Promise<SteamStartResult> {
    if (!this.inFlight) {
      this.inFlight = startSteam(this.d, { waitMs, why })
        .then((r) => {
          this.d.log(`steam start (${why}): ${r.state}: ${r.said}`);
          if (r.state === 'already' || r.state === 'started') this.healthy();
          return r;
        })
        .finally(() => (this.inFlight = undefined));
    }
    return this.inFlight;
  }

  private healthy() {
    this.autoFailures = 0;
    this.autoNextAt = 0;
    this.autoTries = [];
  }

  /** The named operation, asked by a person through the portal (ops_worker steam_start). */
  manual(why: string): Promise<SteamStartResult> {
    return this.once(MANUAL_WAIT_MS, why);
  }

  /**
   * Before the players broker starts a player on Windows: Steam installed but not running is started first (above).
   * Answers whether the launch goes on, or its refusal when a try left Steam not running. Never throws.
   */
  async beforePlayer(who: string): Promise<{ ok: true } | { refused: string }> {
    try {
      if (this.d.platform !== 'win32') return { ok: true };
      if (!this.inFlight) {
        const exe = await resolveSteamExe(this.d);
        if ('missing' in exe) return { ok: true };
        if (await steamRunning(this.d)) return (this.healthy(), { ok: true });
      }
      // A start already under way (a person's, or another launch's, begun while this one read): join it, bounded, and
      // count nothing; only the caller that began a start spends a try and moves the backoff on (w6732).
      if (this.inFlight) return await this.join(who);
      const now = this.d.now().getTime();
      this.autoTries = this.autoTries.filter((t) => now - t < AUTO_WINDOW_MS);
      if (this.autoTries.length >= AUTO_MAX) {
        this.d.log(`steam start (players launch for ${who}): Steam is not running, but ${AUTO_MAX} automatic tries in ${AUTO_WINDOW_MS / 3_600_000} h failed; no more until Steam is seen running or a person starts it (ops_worker steam_start); the player starts without it`);
        return { ok: true };
      }
      if (now < this.autoNextAt) {
        this.d.log(`steam start (players launch for ${who}): Steam is not running; the last automatic try failed, the next is after ${new Date(this.autoNextAt).toISOString().slice(11, 16)}Z; the player starts without it`);
        return { ok: true };
      }
      this.autoTries.push(now);
      const n = this.autoTries.length;
      const r = await this.once(AUTO_WAIT_MS, `players launch for ${who}, automatic try ${n} of ${AUTO_MAX} in ${AUTO_WINDOW_MS / 3_600_000} h`);
      if (r.state === 'refused') {
        // Nothing was started (no desktop user, not Medium): no try spent, checked again in a few minutes, the player as before.
        this.autoTries.pop();
        this.autoNextAt = Math.max(this.autoNextAt, this.d.now().getTime() + AUTO_BACKOFF_MS[0]);
        return { ok: true };
      }
      if (r.state !== 'failed') return { ok: true };
      this.autoFailures++;
      this.autoNextAt = this.d.now().getTime() + AUTO_BACKOFF_MS[Math.min(this.autoFailures, AUTO_BACKOFF_MS.length) - 1];
      return {
        refused: `Steam is not running on this computer and the daemon's start of it failed: ${r.said}. The next automatic try is after ${new Date(this.autoNextAt).toISOString().slice(11, 16)}Z (try ${n} of ${AUTO_MAX} in ${AUTO_WINDOW_MS / 3_600_000} h); a person can start it with ops_worker steam_start`,
      };
    } catch (e) {
      this.d.log(`steam start (players launch for ${who}): the check failed (${(e as Error).message}); the player starts as before`);
      return { ok: true };
    }
  }

  /** A launch that finds a start under way waits for it at most AUTO_WAIT_MS (a person's start waits longer), counting nothing. */
  private async join(who: string): Promise<{ ok: true } | { refused: string }> {
    const running = this.inFlight;
    if (!running) return { ok: true };
    const r = await Promise.race([running, this.d.sleep(AUTO_WAIT_MS).then(() => undefined)]);
    if (!r) {
      this.d.log(`steam start (players launch for ${who}): a Steam start under way did not finish in ${AUTO_WAIT_MS / 1000} s; the player starts without waiting longer`);
      return { ok: true };
    }
    if (r.state !== 'failed') return { ok: true };
    return { refused: `Steam is not running on this computer and the daemon's start of it, under way when this launch came, failed: ${r.said}` };
  }
}
