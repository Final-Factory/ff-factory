// w4601: the game players this machine's shared player cache holds, for the portal's pair placement.
//
// The game repo's scripts/nightly/player_cache.py (w4549, w4550) keeps one development multiplayer player per commit and
// target in <FF_WORKER_ROOT>/player-cache/<40 hex sha>-<mac|win|linux>[-burstN], and build_player.sh skips the build when
// the entry's build-manifest.json says "status": "ok". w4596's timelines of 12 pair runs: each leg built its own player
// of the head commit (3 to 23 min) while the requester had usually just built that same commit for its --dry run. The
// daemon reports the ready entries with its stats, so placement puts a leg where the player already is
// (shared/capacity.ts pairRoom) and the leg's first message names its path (server/agents.ts startPairLegs).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PlayerCacheReport } from '../shared/types.ts';

/** The entry folders player_cache.py makes and evicts (its ENTRY_RE). */
export const PLAYER_CACHE_ENTRY = /^[0-9a-f]{40}-(mac|win|linux)(-burst[0-9]+)?$/;
/** Entries reported at most: the cache keeps 8 by default (FF_PLAYER_CACHE_MAX_ENTRIES). */
const MAX_ENTRIES = 32;

/** The cache folder: FF_PLAYER_CACHE, else <worker root>/player-cache, as player_cache.py's cache_root(). */
export function playerCacheRoot(workerRoot: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.FF_PLAYER_CACHE?.trim();
  if (explicit) return path.resolve(explicit);
  return workerRoot ? path.join(workerRoot, 'player-cache') : undefined;
}

/**
 * The ready entries of the cache at `root` (a build-manifest.json whose status is ok, as build_player.sh's cache_ok), newest
 * build first; undefined when there is no cache folder. Entries still building or failed are left out: a leg told to use
 * one would find no player.
 */
export function readPlayerCache(root: string | undefined): PlayerCacheReport | undefined {
  if (!root) return undefined;
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  const entries: PlayerCacheReport['entries'] = [];
  for (const key of names) {
    if (!PLAYER_CACHE_ENTRY.test(key)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(root, key, 'build-manifest.json'), 'utf8')) as { status?: unknown; finished?: unknown };
      if (m.status !== 'ok') continue;
      if (!fs.existsSync(path.join(root, key, 'player'))) continue;
      entries.push({ key, ...(typeof m.finished === 'string' ? { at: m.finished } : {}) });
    } catch {
      continue;
    }
  }
  entries.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return { root, entries: entries.slice(0, MAX_ENTRIES) };
}

// ---------------------------------------------------------------- w4613: handing a player to another computer

/** The player cache's target for this machine's OS (player_cache.py TARGETS), or undefined. */
export function cacheTarget(platform: NodeJS.Platform = process.platform): 'win' | 'mac' | 'linux' | undefined {
  return platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : undefined;
}

/**
 * The tar this machine packs and unpacks players with: Windows' own bsdtar (System32\tar.exe) there, since Git's GNU tar
 * reads "C:\..." as a remote host; `tar` elsewhere.
 */
export function tarCommand(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform !== 'win32') return 'tar';
  const own = path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(own) ? own : 'tar';
}

/** A run of tar that resolves on exit 0 and rejects with the end of its stderr otherwise. */
export type TarRunner = (args: string[]) => Promise<void>;

export const runTar: TarRunner = (args) =>
  new Promise((resolve, reject) => {
    const p = spawn(tarCommand(), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`))));
  });

function readManifest(entry: string): { status?: unknown; sha?: unknown; target?: unknown } | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(entry, 'build-manifest.json'), 'utf8')) as { status?: unknown; sha?: unknown; target?: unknown };
  } catch {
    return undefined;
  }
}

/** Why the cache entry at `entry` is not a ready player of `sha` for `target`, or '' when it is (w4613). */
export function playerEntryProblem(entry: string, sha: string, target: string): string {
  const m = readManifest(entry);
  if (!m) return 'it has no readable build-manifest.json';
  if (m.status !== 'ok') return `its build-manifest.json says status ${JSON.stringify(m.status ?? null)}, not ok (a failed build, or one still running)`;
  if (typeof m.sha !== 'string' || m.sha.toLowerCase() !== sha) return `its build-manifest.json is of commit ${typeof m.sha === 'string' ? m.sha.slice(0, 10) : 'none'}, not ${sha.slice(0, 10)}`;
  if (typeof m.target === 'string' && m.target !== target) return `its build-manifest.json is a ${m.target} player, not ${target}`;
  if (!fs.existsSync(path.join(entry, 'player'))) return 'it has no player folder';
  return '';
}

/** One line in the cache's cache.log, as player_cache.py's log() writes them. */
function cacheLog(root: string, event: string, key: string, note: string) {
  try {
    fs.appendFileSync(path.join(root, 'cache.log'), `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} ${event} ${key} ff-factory ${note}\n`);
  } catch {
    // The log is for people; a cache that cannot take a line still serves the player.
  }
}

/**
 * publish_attachment with player (w4613): pack this machine's ready cache entry of `commit` (7 to 40 hex) for its own OS
 * into `<outDir>/player-<sha>-<os>.tar.gz` (player/ and build-manifest.json), and answer that file. Refused when the cache
 * has no such entry, more than one matches a short commit, or the entry's manifest is not ok for that commit and OS.
 */
export async function packPlayer(
  root: string | undefined,
  commit: unknown,
  outDir: string,
  o: { platform?: NodeJS.Platform; tar?: TarRunner } = {},
): Promise<{ file: string; key: string }> {
  const c = String(commit ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(c)) throw new Error('player: the commit whose player to hand on, 7 to 40 hex digits');
  const target = cacheTarget(o.platform);
  if (!target) throw new Error('this computer has no player cache target');
  if (!root) throw new Error('this computer has no player cache (no worker root and no FF_PLAYER_CACHE)');
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    names = [];
  }
  const hits = names.filter((n) => PLAYER_CACHE_ENTRY.test(n) && n.endsWith(`-${target}`) && n.startsWith(c));
  if (!hits.length) throw new Error(`this computer's player cache (${root}) holds no ${target} player of ${c.slice(0, 10)}: build it first (scripts/nightly/build_player.sh writes it there)`);
  if (hits.length > 1) throw new Error(`${c} matches ${hits.length} cached players (${hits.join(', ')}): give more of the commit`);
  const key = hits[0];
  const entry = path.join(root, key);
  const why = playerEntryProblem(entry, key.slice(0, 40), target);
  if (why) throw new Error(`the cached player ${key} cannot be handed on: ${why}`);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `player-${key}.tar.gz`);
  fs.rmSync(file, { force: true });
  try {
    await (o.tar ?? runTar)(['-czf', file, '-C', entry, 'build-manifest.json', 'player']);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  return { file, key };
}

/**
 * fetch_attachment of a packed player (w4613): unpack `tarball` (named player-<sha>-<os>.tar.gz) into this machine's cache
 * as the entry `<sha>-<os>`, beside the ones build_player.sh makes, and answer its player folder. Refused for another OS's
 * player, and for one whose manifest is not ok for that commit (a stale or failed build); an entry already ready here is
 * kept as it is. The tarball is deleted either way. Clean-up is player_cache.py evict's, as for a built entry.
 */
export async function installPlayer(
  root: string | undefined,
  tarball: string,
  name: string,
  o: { platform?: NodeJS.Platform; tar?: TarRunner } = {},
): Promise<{ entry: string; player: string; fresh: boolean }> {
  try {
    const m = /^player-([0-9a-f]{40})-(win|mac|linux)\.tar\.gz$/.exec(name);
    if (!m) throw new Error(`${name} is not a packed player (player-<sha>-<os>.tar.gz)`);
    const sha = m[1];
    const os = m[2];
    const key = `${sha}-${os}`;
    const target = cacheTarget(o.platform);
    if (os !== target) throw new Error(`it is a ${os} player and this computer runs ${target ?? 'another OS'}: build the player here instead`);
    if (!root) throw new Error('this computer has no player cache (no worker root and no FF_PLAYER_CACHE)');
    const entry = path.join(root, key);
    if (!playerEntryProblem(entry, sha, os)) {
      fs.writeFileSync(path.join(entry, 'last-used'), `${new Date().toISOString()}\n`);
      cacheLog(root, 'hit', key, 'fetch_attachment found it already here (w4613)');
      return { entry, player: path.join(entry, 'player'), fresh: false };
    }
    if (fs.existsSync(entry)) {
      throw new Error(`this computer's cache already has ${key} and it is not ready (${playerEntryProblem(entry, sha, os)}): build the player here with build_player.sh, which rebuilds it`);
    }
    const work = path.join(root, `.fetch-${key}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      await (o.tar ?? runTar)(['-xzf', tarball, '-C', work]);
      const why = playerEntryProblem(work, sha, os);
      if (why) throw new Error(`the packed player was refused: ${why}`);
      fs.writeFileSync(path.join(work, 'last-used'), `${new Date().toISOString()}\n`);
      fs.renameSync(work, entry);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    cacheLog(root, 'fetched', key, "from another computer's cache by fetch_attachment (w4613)");
    return { entry, player: path.join(entry, 'player'), fresh: true };
  } finally {
    fs.rmSync(tarball, { force: true });
  }
}
