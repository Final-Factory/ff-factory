import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cacheTarget, installPlayer, packPlayer, playerEntryProblem, readPlayerCache } from './playerCache.ts';

const SHA = '670a034960aa11bb22cc33dd44ee55ff66778899';
const here = cacheTarget()!;

function tmp(t: { after: (f: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w4613-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A cache entry as build_player.sh leaves it: player/ with a file in it, and its build-manifest.json. */
function entry(root: string, sha: string, target: string, manifest: Record<string, unknown>): string {
  const e = path.join(root, `${sha}-${target}`);
  fs.mkdirSync(path.join(e, 'player', 'finalfactory_Data'), { recursive: true });
  fs.writeFileSync(path.join(e, 'player', 'finalfactory_Data', 'data.unity3d'), 'game data');
  fs.writeFileSync(path.join(e, 'build-manifest.json'), JSON.stringify({ sha, target, key: `${sha}-${target}`, buildSeconds: 229, finished: '2026-11-17T16:00:00Z', ...manifest }, null, 2));
  return e;
}

test('w4613: a ready player packs from one computer\'s cache and installs into another\'s as a ready entry build_player.sh would skip, with real tar', async (t) => {
  const a = path.join(tmp(t), 'a');
  const b = path.join(tmp(t), 'b');
  const out = path.join(tmp(t), 'out');
  entry(a, SHA, here, { status: 'ok' });
  const packed = await packPlayer(a, SHA.slice(0, 10), out);
  assert.equal(path.basename(packed.file), `player-${SHA}-${here}.tar.gz`);
  assert.equal(packed.key, `${SHA}-${here}`);
  const got = await installPlayer(b, packed.file, path.basename(packed.file));
  assert.equal(got.fresh, true);
  assert.equal(got.entry, path.join(b, `${SHA}-${here}`));
  assert.equal(fs.readFileSync(path.join(got.player, 'finalfactory_Data', 'data.unity3d'), 'utf8'), 'game data');
  assert.equal(playerEntryProblem(got.entry, SHA, here), '');
  assert.ok(fs.existsSync(path.join(got.entry, 'last-used')));
  assert.match(fs.readFileSync(path.join(b, 'cache.log'), 'utf8'), new RegExp(`fetched ${SHA}-${here} ff-factory`));
  assert.equal(fs.existsSync(packed.file), false, 'the tarball is deleted once installed');
  assert.deepEqual(fs.readdirSync(b).filter((n) => n.startsWith('.fetch')), [], 'no work folder left');
  assert.deepEqual(readPlayerCache(b)?.entries.map((e) => e.key), [`${SHA}-${here}`], 'the daemon reports it, so placement and w4601 see it');
  // Fetched again where it is already ready: kept as it is, a hit.
  const again = await packPlayer(a, SHA, out);
  const kept = await installPlayer(b, again.file, path.basename(again.file));
  assert.equal(kept.fresh, false);
  assert.match(fs.readFileSync(path.join(b, 'cache.log'), 'utf8'), /hit .* fetch_attachment found it already here/);
});

test('w4613: a failed, stale or foreign player is refused: no pack of a failed entry, no install of another OS\'s player, of a tarball whose manifest is not ok for its commit, or over an entry not ready', async (t) => {
  const a = path.join(tmp(t), 'a');
  const b = path.join(tmp(t), 'b');
  const out = path.join(tmp(t), 'out');
  entry(a, SHA, here, { status: 'failed' });
  await assert.rejects(packPlayer(a, SHA, out), /cannot be handed on: its build-manifest\.json says status "failed", not ok/);
  await assert.rejects(packPlayer(a, 'abcdef1', out), /holds no .* player of abcdef1: build it first/);
  await assert.rejects(packPlayer(a, 'xyz', out), /7 to 40 hex digits/);
  // Two entries a short commit matches.
  entry(a, `${SHA.slice(0, 8)}${'0'.repeat(32)}`, here, { status: 'ok' });
  fs.rmSync(path.join(a, `${SHA}-${here}`), { recursive: true });
  entry(a, SHA, here, { status: 'ok' });
  await assert.rejects(packPlayer(a, SHA.slice(0, 8), out), /matches 2 cached players/);
  // Another OS's player: refused before anything is unpacked, and the tarball goes.
  const other = here === 'win' ? 'linux' : 'win';
  const foreign = path.join(out, `player-${SHA}-${other}.tar.gz`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(foreign, 'x');
  await assert.rejects(installPlayer(b, foreign, path.basename(foreign)), new RegExp(`it is a ${other} player and this computer runs ${here}: build the player here instead`));
  assert.equal(fs.existsSync(foreign), false);
  // A tarball whose manifest is of another commit (renamed, or stale): refused, nothing left in the cache.
  const good = await packPlayer(a, SHA, out);
  const wrongSha = 'b'.repeat(40);
  const renamed = path.join(out, `player-${wrongSha}-${here}.tar.gz`);
  fs.renameSync(good.file, renamed);
  await assert.rejects(installPlayer(b, renamed, path.basename(renamed)), /the packed player was refused: its build-manifest\.json is of commit 670a034960, not bbbbbbbbbb/);
  assert.deepEqual(fs.existsSync(b) ? fs.readdirSync(b).filter((n) => n !== 'cache.log') : [], [], 'nothing installed, no work folder left');
  // The receiving cache has the entry mid-build (no ok manifest): left alone.
  entry(b, SHA, here, { status: 'building' });
  const again = await packPlayer(a, SHA, out);
  await assert.rejects(installPlayer(b, again.file, path.basename(again.file)), /already has .* and it is not ready/);
  assert.match(fs.readFileSync(path.join(b, `${SHA}-${here}`, 'build-manifest.json'), 'utf8'), /"building"/);
});
