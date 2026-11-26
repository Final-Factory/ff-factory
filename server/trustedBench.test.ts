import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { benchTicketFor, newestBenchQueueScript, refreshTrustedBench, refreshTrustedBenchAsync, resetBenchFetches, trustedBenchScript, TRUSTED_BENCH_MAX_AGE_MS } from '../machine/benchQueue.ts';

/**
 * w5572 (from w5542's audit): the daemon and the agent host took their bench tickets with the bench_queue.py of highest
 * RULES_VERSION among every sandbox, which a worker can write, so a planted copy ran at the host's level. Now they run only
 * the game repo's master copy kept in the daemon's folder, with `python -s` from a PATH that holds no worker-writable folder.
 */

const PY = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(PY, ['--version']).status === 0;

function put(file: string, text: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}

/** A queue script that leaves a marker `name` in `marks` (with its argv and whether the user site was off), then exits. */
const marking = (marks: string, name: string, version: number) =>
  `RULES_VERSION = ${version}\nimport pathlib, sys\npathlib.Path(${JSON.stringify(marks)}, ${JSON.stringify(name)}).write_text(str(sys.flags.no_user_site) + " " + " ".join(sys.argv[1:3]))\n`;

async function until(ok: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end && !ok(); ) await new Promise((r) => setTimeout(r, 50));
}

test('w5572: a planted higher-RULES_VERSION bench_queue.py in a sandbox is never run by the host; the trusted copy is', { skip: !hasPython && `no ${PY}` }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5572-root-'));
  const marks = path.join(root, 'tmp', 'marks');
  fs.mkdirSync(marks, { recursive: true });
  const appDir = path.join(root, 'daemon');
  const sandbox = path.join(root, 'sandboxes', 'slot1');
  put(path.join(sandbox, 'scripts', 'bench', 'bench_queue.py'), marking(marks, 'planted', 999));
  // A planted sitecustomize on PYTHONPATH, and (POSIX) a planted python3 first on PATH in a worker-writable folder.
  put(path.join(root, 'sandboxes', 'slot1', 'pyp', 'sitecustomize.py'), `import pathlib\npathlib.Path(${JSON.stringify(marks)}, "sitecustomize").write_text("ran")\n`);
  const slots = path.join(root, 'unity-slots', 'bin');
  if (process.platform !== 'win32') put(path.join(slots, 'python3'), `#!/bin/sh\necho ran > ${JSON.stringify(path.join(marks, 'planted-python'))}\n`, 0o755);
  const env = { ...process.env, PATH: [slots, process.env.PATH].join(path.delimiter), PYTHONPATH: path.join(root, 'sandboxes', 'slot1', 'pyp'), FF_WORKER_ROOT: root, FF_PYTHON: '' };

  // RED: what the host ran before w5572.
  assert.equal(newestBenchQueueScript([sandbox], root), path.join(sandbox, 'scripts', 'bench', 'bench_queue.py'));

  let fetched = 0;
  const trusted = { appDir, fetch: () => (fetched++, { text: marking(marks, 'trusted', 8) }) };
  const r = benchTicketFor({ mode: 'shared', what: 'w5572 test', checkouts: [sandbox], root, env, trusted });
  assert.ok(r.ticket, r.why ?? "no ticket");
  await until(() => fs.existsSync(path.join(marks, 'trusted')));
  r.ticket!.release();
  assert.deepEqual(fs.readdirSync(marks).sort(), ['trusted']);
  assert.equal(fs.readFileSync(path.join(marks, 'trusted'), 'utf8'), '1 --lock ' + path.join(root, 'daemon', 'bench.lock'));
  assert.equal(fetched, 1);
  assert.equal(fs.readFileSync(trustedBenchScript(appDir), 'utf8'), marking(marks, 'trusted', 8));
  fs.rmSync(root, { recursive: true, force: true });
});

test('w5572: the trusted copy is fetched when missing or old, kept when a fetch fails, and refused without RULES_VERSION', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5572-app-'));
  const file = trustedBenchScript(appDir);
  let now = 1_000_000_000_000;
  let answer: { text?: string; error?: string } = { error: 'HTTP 404' };
  let calls = 0;
  const t = { appDir, now: () => now, fetch: () => (calls++, answer) };
  assert.match(refreshTrustedBench(t, undefined) ?? '', /HTTP 404/);
  assert.equal(fs.existsSync(file), false);
  // With no copy at all, the host takes no ticket and says why (it never falls back to a sandbox's copy).
  assert.match(benchTicketFor({ mode: 'shared', what: 'x', checkouts: [], root: appDir, trusted: t }).why ?? '', /no trusted bench_queue\.py.*HTTP 404/);
  answer = { text: 'print(1)\n' };
  assert.match(refreshTrustedBench(t, undefined) ?? '', /no RULES_VERSION/);
  answer = { text: 'RULES_VERSION = 8\n' };
  assert.equal(refreshTrustedBench(t, undefined), undefined);
  now = fs.statSync(file).mtimeMs + 1000;
  calls = 0;
  assert.equal(refreshTrustedBench(t, undefined), undefined);
  assert.equal(calls, 0, 'a fresh copy is not fetched again');
  now += TRUSTED_BENCH_MAX_AGE_MS;
  answer = { error: 'offline' };
  assert.match(refreshTrustedBench(t, undefined) ?? '', /offline/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'RULES_VERSION = 8\n', 'a failed fetch keeps the copy it had');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['bench_queue.py']);
  fs.rmSync(appDir, { recursive: true, force: true });
});

test('w5973: the daemon fetches the trusted copy in the background, one fetch at a time, and never on its own thread', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5973-app-'));
  const file = trustedBenchScript(appDir);
  let now = 1_000_000_000_000;
  let syncCalls = 0;
  let asyncCalls = 0;
  let answer: (v: { text?: string; error?: string }) => void = () => undefined;
  const t = { appDir, background: true, now: () => now, fetch: () => (syncCalls++, { text: 'RULES_VERSION = 1\n' }), fetchAsync: () => (asyncCalls++, new Promise<{ text?: string; error?: string }>((r) => (answer = r))) };
  // No copy yet: refused as before, saying the fetch has started; a second call while it runs starts no second one.
  assert.match(refreshTrustedBench(t, undefined) ?? '', /fetching master's scripts\/bench\/bench_queue\.py in the background/);
  assert.match(refreshTrustedBench(t, undefined) ?? '', /in the background/);
  assert.equal(asyncCalls, 1);
  assert.equal(syncCalls, 0, 'the blocking fetch never runs in background mode');
  answer({ text: 'RULES_VERSION = 9\n' });
  assert.equal(await refreshTrustedBenchAsync(t, undefined), undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), 'RULES_VERSION = 9\n');
  assert.equal(refreshTrustedBench(t, undefined), undefined, 'fresh: nothing to fetch');
  // Old: the call goes on with the copy it has while one fetch runs; a failed fetch keeps it.
  now = fs.statSync(file).mtimeMs + TRUSTED_BENCH_MAX_AGE_MS + 1;
  assert.equal(refreshTrustedBench(t, undefined), undefined);
  assert.equal(asyncCalls, 2);
  const pending = refreshTrustedBenchAsync(t, undefined);
  assert.equal(asyncCalls, 2, 'a call while one runs shares it');
  answer({ error: 'offline' });
  assert.match((await pending) ?? '', /offline/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'RULES_VERSION = 9\n');
  fs.rmSync(appDir, { recursive: true, force: true });
});

test("w5973 (w5998's review): a background fetch that just failed is not started again on each call, and its error is the refusal", async () => {
  resetBenchFetches();
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5973-fail-'));
  let now = 1_000_000_000_000;
  let calls = 0;
  const t = { appDir, background: true, now: () => now, fetchAsync: async () => (calls++, { error: 'HTTP 401: Bad credentials' }) };
  assert.match(refreshTrustedBench(t, undefined) ?? '', /in the background/);
  assert.match((await refreshTrustedBenchAsync(t, undefined)) ?? '', /Bad credentials/, 'the call that started it shares its answer');
  assert.equal(calls, 1);
  assert.match(refreshTrustedBench(t, undefined) ?? '', /Bad credentials/, "the refusal is gh's error, not 'fetching'");
  assert.equal(calls, 1, 'no second fetch within the minute');
  now += 61_000;
  refreshTrustedBench(t, undefined);
  await refreshTrustedBenchAsync(t, undefined);
  assert.equal(calls, 2, 'tried again after a minute');
  resetBenchFetches();
  fs.rmSync(appDir, { recursive: true, force: true });
});
