import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CleanupFacts } from './cleanupFolders.ts';

/**
 * w5300: on m5 (w5280, 2026-11-23) `ff-leftovers remove <p1>..<p5>` with five old cached players in one call kept all five,
 * though `check` judged each DELETE, and one path per call removed them. Its KEEP reason was cut off in that run's output, and
 * it did not come back: here the real CLI runs from a shell whose own command line names every path (as an agent's Bash call
 * does) with the real process list, so the shell, which names each entry, must be skipped as the command's caller and every
 * DELETE path removed, while a KEEP path in the same call stays with its reason. Fixtures only.
 */
const HOUR = 3_600_000;
const NOW = Date.now();
const script = path.join(import.meta.dirname, '..', 'machine', 'leftovers.ts');

function put(root: string, rel: string, ageH: number, body = 'x') {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  const at = (NOW - ageH * HOUR) / 1000;
  for (let p = f; p.length > root.length; p = path.dirname(p)) fs.utimesSync(p, at, at);
}

function player(root: string, c: string, ageH: number): string {
  const key = `${c.repeat(40)}-linux`;
  const e = `player-cache/${key}`;
  put(root, `${e}/player/finalfactory.x86_64`, ageH, 'p'.repeat(1000));
  put(root, `${e}/build-manifest.json`, ageH, JSON.stringify({ key, status: 'ok', finished: new Date(NOW - ageH * HOUR).toISOString().slice(0, 19) + 'Z' }));
  put(root, `${e}/last-used`, ageH, '');
  return path.join(root, ...e.split('/'));
}

test('w5300: one remove call with several DELETE paths removes each, and a KEEP path in it stays with its reason', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w5300-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The two newest ready builds stay (PLAYER_CACHE_KEEP_NEWEST); c, d and e are old and nothing uses them.
  const newest = player(root, 'a', 2);
  player(root, 'b', 3);
  const old = [player(root, 'c', 30), player(root, 'd', 40), player(root, 'e', 50)];
  put(root, 'player-cache/cache.log', 1, '');
  const facts: CleanupFacts = {
    at: new Date(NOW + 60_000).toISOString(),
    connected: true,
    root,
    tempRoot: path.join(root, 'tmp'),
    sandboxes: [],
    live: [],
    resumable: [],
    owners: {},
    open: [],
    closed: [],
    contextAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(root, 'daemon'));
  const file = path.join(root, 'daemon', 'cleanup-facts.json');
  fs.writeFileSync(file, JSON.stringify(facts));
  const env = { ...process.env, FF_CLEANUP_FACTS: file, FF_LEFTOVERS_REMOVE_LOG: path.join(root, 'removed.jsonl') };
  const args = [...old, newest];
  const q = (s: string) => `"${s.replace(/\\/g, '/')}"`;
  // A shell that names every path in its own command line, then runs the CLI and stays its parent (`; true`, no exec).
  const line = `${[process.execPath, ...process.execArgv, script, 'remove', ...args].map(q).join(' ')}; true`;
  const out = execFileSync(process.platform === 'win32' ? 'bash' : 'sh', ['-c', line], { env, encoding: 'utf8' });
  for (const p of old) {
    assert.equal(fs.existsSync(p), false, `${p} removed\n${out}`);
    assert.match(out, new RegExp(`^REMOVED .*${path.basename(p)}\\n`, 'm'));
  }
  assert.ok(fs.existsSync(newest), out);
  assert.match(out, new RegExp(`^KEEP    .*${path.basename(newest)}\\n\\s+not removed: .*one of the 2 newest ready builds`, 'm'));
  assert.equal(out.match(/^REMOVED /gm)?.length, 3, out);
});
