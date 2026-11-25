/**
 * w5564 (rogue-worker audit w5451, item 33): the players the daemon itself starts run fenced on Linux and macOS.
 *
 * A timed run's player is a file in a folder fenced workers can write (`<root>/players/<slot>/player`, or
 * `<root>/timing/builds/b<i>`), and the daemon is not fenced. Started as the daemon's plain child, a player a worker swapped
 * would run with the daemon's rights: write anywhere the user can. So on Linux it starts under machine/ff-landlock.py and on
 * macOS under sandbox-exec, the wrappers workers run under, with a tighter list: it writes only in its run folder, its own
 * build folder, and the game's data root and player home when those are inside the worker root (saves, settings, reports).
 * Windows needs none of this: a player in a Low-labelled folder already runs at Low integrity (docs/worker-root.md 4.1).
 *
 * It fails closed: when the fence cannot run here (no Landlock in the kernel, no python3, no sandbox-exec) the leg is
 * refused with the reason, never started unfenced. Reads, exec and the network stay open, as they do for workers.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { probeFence } from './fenceProbe.ts';
import { FF_LANDLOCK } from './writeLock.ts';
import { SANDBOX_EXEC } from '../server/workerFence.ts';

export type PlayerFence =
  | { kind: 'none' }
  | { kind: 'landlock'; python: string; script: string }
  | { kind: 'seatbelt'; darwinTemp: string; darwinCache: string }
  | { kind: 'unavailable'; why: string };

/** A player's command line, before or after the fence. */
export interface PlayerLaunch {
  cmd: string;
  args: string[];
}

/** The folders a player of the daemon may write. */
export interface PlayerWritable {
  /** The worker root: a folder outside it is never opened to a player. */
  root: string;
  /** The timed run's own folder (its legs' player.log, cpu.csv). */
  runDir: string;
  /** The build folder the player runs from. */
  buildDir: string;
  /** The process environment the player gets (FF_GAME_DATA_DIR, FF_PLAYER_HOME). */
  env: NodeJS.ProcessEnv;
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const inside = (p: string, root: string) => {
  const r = path.relative(root, p);
  return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r));
};

/**
 * The folders a player may write, resolved, each inside the root: its run folder, its build folder, the game's data root
 * (FF_GAME_DATA_DIR: saves, the automation report, AgentControl) and its player home (FF_PLAYER_HOME: Unity's prefs). A
 * data root outside the worker root (a person's own, or an older build's legacy root under the home) stays read-only.
 */
export function playerWritable(w: PlayerWritable): string[] {
  const root = real(w.root);
  const want = [w.runDir, w.buildDir, w.env.FF_GAME_DATA_DIR?.trim(), w.env.FF_PLAYER_HOME?.trim()].filter((p): p is string => !!p && path.isAbsolute(p)).map(real);
  // The root itself, the daemon's folder and the secrets never, though a setting named them.
  const closed = ['daemon', 'secrets'].map((n) => path.join(root, n));
  return [...new Set(want)].filter((p) => p !== root && inside(p, root) && !closed.some((c) => inside(p, c)));
}

/** An SBPL string literal. */
const lit = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The player's Seatbelt profile: every file write refused, except its folders, the device nodes, and the per-user Darwin
 * temp and cache folders (Metal's shader cache and CoreServices write there with no setting; the same exception as the
 * worker fence, server/workerFence.ts).
 */
export function playerSeatbeltProfile(f: { darwinTemp: string; darwinCache: string }, writable: string[]): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")',
    '  (literal "/dev/random") (literal "/dev/urandom") (regex #"^/dev/fd/[0-9]+$"))',
    `(allow file-write* (subpath ${lit(f.darwinTemp)}) (subpath ${lit(f.darwinCache)}))`,
    ...(writable.length ? ['(allow file-write*', ...writable.map((p) => `  (subpath ${lit(p)})`), ')'] : []),
  ].join('\n');
}

/**
 * ff-landlock.py's arguments for a player: its folders, and /dev (the GPU, /dev/shm, /dev/null) and /proc (a process's own
 * oom_score_adj; file modes decide the rest), the two the worker lock opens for the same reasons (machine/writeLock.ts).
 * Not /tmp and not the home: a timed-run player on biscuit ran its leg without them (w5564).
 */
export const playerLandlockArgs = (writable: string[]) => ['--rw', '/dev', '--rw', '/proc', ...writable.flatMap((p) => ['--rw', p])];

/** `launch` inside the fence, or why it cannot start. A `none` fence (Windows) returns it as it is. */
export function fencedPlayer(f: PlayerFence, launch: PlayerLaunch, writable: string[]): PlayerLaunch | { refused: string } {
  switch (f.kind) {
    case 'none':
      return launch;
    case 'unavailable':
      return { refused: `the player fence cannot run here (${f.why}); a daemon-started player never runs unfenced (w5564)` };
    case 'landlock':
      return { cmd: f.python, args: [f.script, ...playerLandlockArgs(writable), '--', launch.cmd, ...launch.args] };
    case 'seatbelt':
      return { cmd: SANDBOX_EXEC, args: ['-p', playerSeatbeltProfile(f, writable), launch.cmd, ...launch.args] };
  }
}

export interface PlayerFenceProbe {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  getconf?: (name: string) => string;
  /** Runs a no-op inside the fence: true when it exited 0. */
  probe?: (launch: PlayerLaunch) => { ok: boolean; why?: string };
}

const confstr = (name: string) => execFileSync('/usr/bin/getconf', [name], { encoding: 'utf8' }).trim().replace(/\/+$/, '');

/**
 * This machine's player fence: none on Windows, Landlock on Linux, Seatbelt on macOS, each probed once with a no-op inside
 * it; `unavailable` (with why) when the probe fails or the wrapper is missing, which refuses the leg. Independent of the
 * worker fence settings (daemon.json `writeLock`, `workerFence`): a player in a folder workers write is fenced whether or not
 * the workers are.
 */
export function playerFenceFor(o: PlayerFenceProbe = {}): PlayerFence {
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? fs.existsSync;
  const probe = o.probe ?? ((l: PlayerLaunch) => probeFence([l.cmd, ...l.args]));
  let f: PlayerFence;
  try {
    if (platform === 'win32') return { kind: 'none' };
    if (platform === 'linux') {
      if (!exists(FF_LANDLOCK)) return { kind: 'unavailable', why: `${FF_LANDLOCK} is missing` };
      f = { kind: 'landlock', python: exists('/usr/bin/python3') ? '/usr/bin/python3' : 'python3', script: FF_LANDLOCK };
    } else if (platform === 'darwin') {
      if (!exists(SANDBOX_EXEC)) return { kind: 'unavailable', why: `${SANDBOX_EXEC} is missing` };
      const get = o.getconf ?? confstr;
      f = { kind: 'seatbelt', darwinTemp: real(get('DARWIN_USER_TEMP_DIR')), darwinCache: real(get('DARWIN_USER_CACHE_DIR')) };
    } else return { kind: 'unavailable', why: `no player fence for ${platform}` };
  } catch (e) {
    return { kind: 'unavailable', why: (e as Error).message };
  }
  const noop = fencedPlayer(f, { cmd: '/usr/bin/true', args: [] }, []);
  const r = 'refused' in noop ? { ok: false, why: noop.refused } : probe(noop);
  return r.ok ? f : { kind: 'unavailable', why: `a no-op inside it failed: ${r.why ?? 'unknown'}` };
}
