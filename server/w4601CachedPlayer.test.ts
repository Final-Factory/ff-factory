// w4601 (lothsahn, 2026-11-17, about w4596: "file any subsequent findings as high priority fixes and just get them going"):
// w4596's timelines of 12 pair runs showed each leg building its own player of the head commit (Mac 3 to 9 min, Linux on
// biscuit 4 to 21, Windows 7 to 23), while the requester had usually just built that commit for its --dry run; only w4577
// hit a cache, and the host waited up to 15 min for the other leg's build. The daemon now reports the ready players of its
// shared player cache (the game repo's scripts/nightly/player_cache.py), placement puts a leg on the computer that holds the
// pair's commit when it has room, and that leg's first message names the player's path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedPlayerNote, cachedPlayerOf, pairRoom, type RoomFit } from '../shared/capacity.ts';
import type { PlayerCacheReport, Requester, WorkItem } from '../shared/types.ts';
import { roomForWork, type RoomNow } from './placement.ts';
import { playerCacheRoot, readPlayerCache } from '../machine/playerCache.ts';

const SHA = '670a034960aa11bb22cc33dd44ee55ff66778899';
const OTHER = '1f0735720000000000000000000000000000abcd';
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const cache = (root: string, ...keys: string[]): PlayerCacheReport => ({ root, entries: keys.map((key) => ({ key, at: '2026-11-17T16:00:00Z' })) });

const item = (pair: WorkItem['pair']): WorkItem => ({
  id: 'w4610',
  title: 'Pair run for w4601: MP determinism pair on PR #3900',
  brief: 'Run the MP determinism pair at the PR head.',
  priority: 'high',
  keys: [],
  requestedBy: BEN,
  requesters: [BEN],
  humanAsked: false,
  status: 'queued',
  queuedFor: { at: '2026-11-17T17:00:00.000Z' },
  createdAt: '2026-11-17T17:00:00.000Z',
  updatedAt: '2026-11-17T17:00:00.000Z',
  sessionIds: [],
  overlaps: [],
  asks: 0,
  log: [],
  pair,
});

const FIT: Record<string, RoomFit> = {
  beast: { platform: 'win32' },
  lothdesktop: { platform: 'win32', playerCache: cache('V:\\ffw\\player-cache', `${SHA}-win`, `${OTHER}-win`) },
  biscuit: { platform: 'linux', playerCache: cache('/home/ff/ffw/player-cache/', `${OTHER}-linux`) },
  m3: { platform: 'darwin' },
};

test('w4601: a pair leg goes on the computer whose player cache holds the commit, when it has room; without a commit or a hit the order stays', () => {
  const r: RoomNow = { game: ['beast', 'biscuit', 'lothdesktop'], agent: [], held: [], fit: FIT };
  const ids = roomForWork(r, item({ legs: 2, commit: SHA })).ids;
  assert.deepEqual(ids, ['beast', 'biscuit', 'lothdesktop'], 'roomForWork keeps placement order; pairRoom picks');
  assert.deepEqual(pairRoom(item({ legs: 2, commit: SHA }), ids, FIT).pick, ['lothdesktop', 'beast'], 'the cached computer takes leg 1, the next in order the other');
  assert.deepEqual(pairRoom(item({ legs: 2, commit: SHA.slice(0, 10) }), ids, FIT).pick, ['lothdesktop', 'beast'], 'a short commit, as request_pair takes it, matches too');
  assert.deepEqual(pairRoom(item({ legs: 2 }), ids, FIT).pick, ['beast', 'biscuit'], 'no commit: placement order');
  assert.deepEqual(pairRoom(item({ legs: 2, commit: 'abcdef1234' }), ids, FIT).pick, ['beast', 'biscuit'], 'no computer holds it: placement order');
  // Room decides: without room there, the cache does not hold the pair back.
  assert.deepEqual(pairRoom(item({ legs: 2, commit: SHA }), ['beast', 'biscuit'], FIT).pick, ['beast', 'biscuit']);
  // A cache of another OS's player is no hit (biscuit holds OTHER for linux; lothdesktop holds OTHER for win: both hit).
  assert.deepEqual(pairRoom(item({ legs: 2, commit: OTHER }), ids, FIT).pick, ['biscuit', 'lothdesktop']);
  // The Mac still hosts first (w2282); the cached computer takes the client leg ahead of beast.
  assert.deepEqual(pairRoom(item({ legs: 2, commit: SHA }), ['m3', 'beast', 'lothdesktop'], FIT).pick, ['m3', 'lothdesktop']);
});

test('w4613 (w4622): with a published player, a computer of its OS comes after a cache hit, so the leg fetches instead of building', () => {
  const player = { id: 'att_9l7wtia4s4kf', key: `${OTHER}-win`, os: 'win' as const, size: 721_897_932 };
  // w4622: one leg, biscuit (Linux) first in placement's order, and a Windows player: beast takes it.
  assert.deepEqual(pairRoom(item({ legs: 1, commit: OTHER, player }), ['biscuit', 'beast'], { ...FIT, biscuit: { platform: 'linux' } }).pick, ['beast']);
  // A cache hit still comes first, then the player's OS, then the rest in order.
  assert.deepEqual(pairRoom(item({ legs: 2, commit: OTHER, player }), ['biscuit', 'linux2', 'beast'], { ...FIT, linux2: { platform: 'linux' } }).pick, ['biscuit', 'beast']);
  // Without a Windows computer with room, it still runs (that leg builds).
  assert.deepEqual(pairRoom(item({ legs: 1, commit: OTHER, player }), ['m3'], { m3: { platform: 'darwin' } }).pick, ['m3']);
});

test('w4601: cachedPlayerOf names the entry and the player folder on the computer\'s own OS; a narrowed Burst build is no hit', () => {
  assert.deepEqual(cachedPlayerOf(SHA, FIT.lothdesktop), { entry: `V:\\ffw\\player-cache\\${SHA}-win`, player: `V:\\ffw\\player-cache\\${SHA}-win\\player` });
  assert.deepEqual(cachedPlayerOf(OTHER.slice(0, 7), FIT.biscuit), { entry: `/home/ff/ffw/player-cache/${OTHER}-linux`, player: `/home/ff/ffw/player-cache/${OTHER}-linux/player` });
  assert.equal(cachedPlayerOf(SHA, FIT.beast), undefined, 'no cache reported');
  assert.equal(cachedPlayerOf(SHA, { platform: 'darwin', playerCache: cache('/x', `${SHA}-win`) }), undefined, 'a Windows player on a Mac');
  assert.equal(cachedPlayerOf(SHA, { platform: 'win32', playerCache: cache('C:\\x', `${SHA}-win-burst24`) }), undefined, 'the nightly\'s narrowed Burst build');
  assert.equal(cachedPlayerOf('xyz', FIT.lothdesktop), undefined, 'not a commit');
  assert.equal(cachedPlayerOf('670a03', FIT.lothdesktop), undefined, 'under 7 hex is too short to trust');
});

test('w4601: the leg\'s first-message line names the cached player and says to skip the build; none without a hit', () => {
  const note = cachedPlayerNote(SHA, FIT.lothdesktop);
  assert.match(note, /## A player of this commit is already built here \(w4601\)/);
  assert.ok(note.includes(`\`V:\\ffw\\player-cache\\${SHA}-win\\player\``), note);
  assert.match(note, /skip the sandbox build: pass `--player V:\\ffw\\player-cache\\670a034960\w+-win\\player` to `ffnightly\.py run`/);
  assert.equal(cachedPlayerNote(SHA, FIT.beast), '');
  assert.equal(cachedPlayerNote(undefined, FIT.lothdesktop), '');
});

test('w4601: the daemon reports only ready cache entries (build-manifest status ok and a player folder), newest first', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w4601-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = (key: string, manifest: Record<string, unknown> | undefined, player = true) => {
    fs.mkdirSync(path.join(root, key), { recursive: true });
    if (manifest) fs.writeFileSync(path.join(root, key, 'build-manifest.json'), JSON.stringify(manifest, null, 2));
    if (player) fs.mkdirSync(path.join(root, key, 'player'));
  };
  entry(`${SHA}-win`, { status: 'ok', finished: '2026-11-17T16:00:00Z' });
  entry(`${OTHER}-linux`, { status: 'ok', finished: '2026-11-17T17:00:00Z' });
  entry(`${'a'.repeat(40)}-win`, { status: 'build-failed' });
  entry(`${'b'.repeat(40)}-mac`, undefined, false); // still building: no manifest yet
  entry(`${'c'.repeat(40)}-mac`, { status: 'ok' }, false); // its player folder is gone
  entry('scratch', { status: 'ok' });
  fs.writeFileSync(path.join(root, 'cache.log'), 'x');
  assert.deepEqual(readPlayerCache(root), { root, entries: [{ key: `${OTHER}-linux`, at: '2026-11-17T17:00:00Z' }, { key: `${SHA}-win`, at: '2026-11-17T16:00:00Z' }] });
  assert.equal(readPlayerCache(path.join(root, 'none')), undefined);
  assert.equal(readPlayerCache(undefined), undefined);
  assert.equal(playerCacheRoot('/w', {}), path.join('/w', 'player-cache'));
  assert.equal(playerCacheRoot('/w', { FF_PLAYER_CACHE: root }), path.resolve(root));
  assert.equal(playerCacheRoot(undefined, {}), undefined);
});
