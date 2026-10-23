import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkRawUnityBatch } from './guard.ts';

/**
 * w1860 (lothsahn, 2026-10-23: "Please make sure every build or CPU intensive job scheduled by the portal takes a lock.
 * Shared unless it's a performance sensitive job like a timing run"): every place FF Factory's own code starts a Unity
 * (an editor or a batch run) or a game player is listed here with the bench ticket it holds. A new launch path fails this
 * test until it is added, with its ticket, so none starts without one by accident.
 *
 * What workers start runs through the game repo's launchers, each holding its own ticket (Documentation/Bench-Lock.md):
 * `unity-slot run` / `ff_unity_slot` / `unity_slot.py run` / `build_player.sh` (shared, exclusive for a timed run),
 * `player_slots.py launch` (a shared ticket for the player's life, w1860), `quiet_gate.sh bench_lock` (exclusive), the
 * nightly (`ffnightly.py --lock-night`: one shared ticket for the night) and `urgent_release.py` (exclusive, pre-empting).
 * A raw `Unity -batchmode` or `Unity -projectPath` from a worker's shell is refused by the guard (checkRawUnityBatch), and
 * a raw player outside the slot pool too (checkPlayerLaunch).
 */

const ROOT = path.resolve(import.meta.dirname, '..');

/** The launch paths and their tickets: file (from the repo root), the pattern kind found there, what it starts, its ticket. */
const CENSUS: { file: string; kind: 'unity argv' | 'player spawn'; job: string; ticket: string }[] = [
  {
    file: 'machine/unity.ts',
    kind: 'unity argv',
    job: "a sandbox's Unity editor (UnityEditor.start, `unity start`, the pool's starts and reopens)",
    ticket: 'shared "running editor <sandbox>", taken before the launch and held while the editor runs (machine/sandboxes.ts bootTicket, w1860)',
  },
];

/** An argv that opens a Unity project or runs Unity in batch mode: a '-projectPath' or '-batchmode' element in an array literal. */
const UNITY_ARGV = /\[\s*(?:[^\]]*,\s*)?['"`]-(?:projectPath|batchmode)['"`]/i;
/** A process started on a built game player's binary. */
const PLAYER_SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|exec)\([^;\n]*final ?factory[^;\n]*?\.(?:exe|app|x86_64)\b/i;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'test') out.push(...sources(rel));
    } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(rel);
  }
  return out;
}

function found(): { file: string; kind: 'unity argv' | 'player spawn' }[] {
  const out: { file: string; kind: 'unity argv' | 'player spawn' }[] = [];
  for (const file of ['machine', 'server', 'shared', 'scripts'].flatMap(sources)) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (UNITY_ARGV.test(text)) out.push({ file, kind: 'unity argv' });
    if (PLAYER_SPAWN.test(text)) out.push({ file, kind: 'player spawn' });
  }
  return out;
}

test('w1860: every place FF Factory starts a Unity or a game player is in the census with the bench ticket it holds', () => {
  const hits = found();
  const key = (h: { file: string; kind: string }) => `${h.kind} in ${h.file}`;
  const listed = new Set(CENSUS.map(key));
  const missing = hits.filter((h) => !listed.has(key(h))).map(key);
  assert.deepEqual(missing, [], 'a new launch path: give it a bench ticket (shared, exclusive only for a timed run) and add it to CENSUS with that ticket');
  const stale = CENSUS.filter((c) => !hits.some((h) => key(h) === key(c))).map(key);
  assert.deepEqual(stale, [], 'a census entry whose launch is gone: remove it');
  for (const c of CENSUS) assert.match(c.ticket, /^(shared|exclusive)\b/, `${key(c)} names its ticket's mode`);
});

test('w1860: the census sees a new launch path (the patterns catch an editor argv, a batch argv and a player spawn)', () => {
  assert.match("await this.d.launch(bin, ['-projectPath', this.repo], this.repo)", UNITY_ARGV);
  assert.match("spawn(unity, ['-quit', '-batchmode', '-projectPath', p])", UNITY_ARGV);
  assert.match("spawn(path.join(slot, 'FinalFactory.exe'), args)", PLAYER_SPAWN);
  assert.doesNotMatch("flagValue(args, '-projectPath', platform)", UNITY_ARGV, 'reading an argv is no launch');
});

test('w1860: the guard refuses an editor opened straight from the shell, as it refuses a raw batch Unity; under unity-slot run both pass', () => {
  assert.match(checkRawUnityBatch('"C:/Program Files/Unity/Hub/Editor/6000.3.0f1/Editor/Unity.exe" -projectPath F:/ffw/sandboxes/slot2') ?? '', /^Refused \(w1860\): .*mcp__machine__unity/);
  assert.match(checkRawUnityBatch('$UNITY -projectPath . -logFile -') ?? '', /^Refused \(w1860\)/);
  assert.match(checkRawUnityBatch('$UNITY -batchmode -projectPath . -quit') ?? '', /^Refused \(w1628\)/);
  assert.equal(checkRawUnityBatch('unity-slot run --count 2 --label peer -- "$UNITY" -projectPath ../clone_0'), undefined);
  assert.equal(checkRawUnityBatch('grep -n projectPath machine/unity.ts'), undefined);
});
