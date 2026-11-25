import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProblem, layOut } from '../machine/timedRunner.ts';
import { hashVariant, writePiece } from '../machine/timedRunPack.ts';

/**
 * w5574 (from w5542's audit): a timed run's players are laid out in folders a worker can write (<root>/timing/builds/b<i>,
 * a sandbox's player slots) from a piece cache it can also write, and "kept" compared only sizes, so a planted file of the
 * same size ran at the daemon's level. Now the folder must hold exactly the order's bytes (the pieces' SHA-256 in the order)
 * before a build is kept and before a player starts.
 */

const MARK = (marks: string, name: string) => `require('fs').writeFileSync(${JSON.stringify(path.join(marks, name))}, 'ran');\n`;

/** The leg's gate as TimedRunner.leg runs it: the player starts only when the folder is the order's build. */
async function legStarts(v: Parameters<typeof buildProblem>[0], dir: string): Promise<string | undefined> {
  const wrong = await buildProblem(v, dir);
  if (wrong) return wrong.problem;
  spawnSync(process.execPath, [path.join(dir, 'player.js')], { cwd: dir });
  return undefined;
}

test('w5574: a planted same-size player file is never run: not kept, not started, and a planted cache piece is refused', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'w5574-'));
  const marks = path.join(t, 'marks');
  fs.mkdirSync(marks);
  const src = path.join(t, 'src');
  fs.mkdirSync(path.join(src, 'Data'), { recursive: true });
  fs.writeFileSync(path.join(src, 'player.js'), MARK(marks, 'real') + '// the real player' + ' '.repeat(40) + '\n');
  fs.writeFileSync(path.join(src, 'Data', 'level0'), 'x'.repeat(5000));
  const files = ['player.js', 'Data/level0'].map((p) => ({ path: p, size: fs.statSync(path.join(src, p)).size }));
  const v = { files, pieces: await hashVariant(src, files) };
  const cache = path.join(t, 'cache');
  fs.mkdirSync(cache);
  for (const p of v.pieces) await writePiece(src, p, path.join(cache, p.sha256));
  const dir = path.join(t, 'root', 'timing', 'builds', 'b0');
  const exe = path.join(dir, 'player.js');
  // A script of the same size as the real one, which leaves the `planted` marker.
  const planted = (() => {
    const body = MARK(marks, 'planted');
    const want = fs.statSync(path.join(src, 'player.js')).size;
    assert.ok(body.length <= want - 3, 'the planted script fits in the real one\'s size');
    return body + '//' + ' '.repeat(want - body.length - 3) + '\n';
  })();
  assert.equal(planted.length, files[0].size);

  assert.equal(await layOut(v, dir, cache), 'written');
  assert.equal(await buildProblem(v, dir), undefined);
  assert.equal(await layOut(v, dir, cache), 'kept');

  // 1. A worker replaces the laid-out player with one of the same size: the next run lays the build out again (the
  // pre-w5574 check, mark and sizes, kept it), and the player that runs is the real one.
  fs.writeFileSync(exe, planted);
  assert.equal(fs.statSync(exe).size, files[0].size);
  assert.equal(await layOut(v, dir, cache), 'written');
  assert.equal(await legStarts(v, dir), undefined);
  assert.deepEqual(fs.readdirSync(marks), ['real']);
  fs.rmSync(path.join(marks, 'real'));

  // 2. The same, after the layout and before a leg (or in the borrowed slot it is linked into): the leg does not start.
  fs.writeFileSync(exe, planted);
  assert.match((await legStarts(v, dir)) ?? '', /player\.js are not the build's/);
  // 3. A file beside the player that the build does not have (a DLL the player would load) is refused too.
  await layOut(v, dir, cache);
  fs.writeFileSync(path.join(dir, 'winhttp.dll'), 'planted');
  assert.match((await legStarts(v, dir)) ?? '', /winhttp\.dll is not one of the build's files/);
  assert.deepEqual(fs.readdirSync(marks), [], 'no player ran');

  // 4. A cache piece of the right size with other bytes: the layout throws, removes what it wrote and that piece.
  const exePiece = v.pieces.find((p) => p.parts.some((x) => x.path === 'player.js'))!;
  const cached = path.join(cache, exePiece.sha256);
  const bytes = fs.readFileSync(cached);
  const at = bytes.indexOf(Buffer.from(fs.readFileSync(path.join(src, 'player.js'))));
  bytes.write(planted, at);
  fs.writeFileSync(cached, bytes);
  fs.rmSync(dir, { recursive: true, force: true });
  await assert.rejects(layOut(v, dir, cache), /not the order's \(w5574\)/);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(cached), false, 'the bad piece is dropped, so the next run fetches it again');
  assert.deepEqual(fs.readdirSync(marks), []);
  fs.rmSync(t, { recursive: true, force: true });
});
