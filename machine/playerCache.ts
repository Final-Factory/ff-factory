// w4601: the game players this machine's shared player cache holds, for the portal's pair placement.
//
// The game repo's scripts/nightly/player_cache.py (w4549, w4550) keeps one development multiplayer player per commit and
// target in <FF_WORKER_ROOT>/player-cache/<40 hex sha>-<mac|win|linux>[-burstN], and build_player.sh skips the build when
// the entry's build-manifest.json says "status": "ok". w4596's timelines of 12 pair runs: each leg built its own player
// of the head commit (3 to 23 min) while the requester had usually just built that same commit for its --dry run. The
// daemon reports the ready entries with its stats, so placement puts a leg where the player already is
// (shared/capacity.ts pairRoom) and the leg's first message names its path (server/agents.ts startPairLegs).

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
