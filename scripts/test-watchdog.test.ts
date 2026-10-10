import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { descendants, inflightLines } from './test-watchdog.ts';
import { track, type InflightTest } from './test-inflight-reporter.ts';

const WATCHDOG = path.join(import.meta.dirname, 'test-watchdog.ts');
// A URL: node loads a reporter as a module, and on Windows an absolute path is not one.
const REPORTER = pathToFileURL(path.join(import.meta.dirname, 'test-inflight-reporter.ts')).href;

test('in-flight reporter: a test is listed from its dequeue until it passes or fails', () => {
  const running = new Map<string, InflightTest>();
  const a = { file: '/r/a.test.ts', line: 3, column: 1, name: 'a', nesting: 0 };
  assert.equal(track(running, 'test:dequeue', a, 1000), true);
  assert.equal(track(running, 'test:diagnostic', a, 1001), false, 'other events change nothing');
  assert.deepEqual([...running.values()], [{ file: '/r/a.test.ts', name: 'a', nesting: 0, since: 1000 }]);
  track(running, 'test:pass', a, 2000);
  assert.equal(running.size, 0);
  track(running, 'test:dequeue', a, 3000);
  track(running, 'test:fail', a, 4000);
  assert.equal(running.size, 0);
});

test('watchdog: the tests still running, by file; a file with none left is a process that does not exit', () => {
  const now = 100_000;
  const lines = inflightLines(
    [
      { file: '/r/a.test.ts', name: '/r/a.test.ts', nesting: 0, since: 10_000 },
      { file: '/r/a.test.ts', name: 'hangs', nesting: 0, since: 40_000 },
      { file: '/r/b.test.ts', name: '/r/b.test.ts', nesting: 0, since: 20_000 },
    ],
    now,
  );
  assert.deepEqual(lines.slice(0, 2), ['/r/a.test.ts: running for 90 s', '  hangs: running for 60 s']);
  assert.match(lines[2], /^\/r\/b\.test\.ts: running for 80 s; its tests are done and its process has not exited/);
  assert.match(inflightLines([], now)[0], /no test is running/);
});

test('watchdog: the processes below the run, not its siblings', () => {
  const procs = [
    { pid: 1, ppid: 0, cmd: 'init' },
    { pid: 10, ppid: 1, cmd: 'node --test' },
    { pid: 11, ppid: 10, cmd: 'node a.test.ts' },
    { pid: 12, ppid: 11, cmd: 'powershell.exe' },
    { pid: 20, ppid: 1, cmd: 'other' },
  ];
  assert.deepEqual(descendants(procs, 10).map((p) => p.pid), [11, 12]);
});

test('watchdog: a hung run is ended at its deadline with exit 124, naming the test that hung', { timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-watchdog-'));
  try {
    const file = path.join(dir, 'hang.test.ts');
    fs.writeFileSync(file, "import { test } from 'node:test';\ntest('quick', () => {});\ntest('waits forever', () => new Promise(() => setInterval(() => {}, 1000)));\n");
    // Coverage off below: the watchdog ends these node processes by force, and one ended while it writes its coverage
    // file leaves it empty (w906). An empty NODE_V8_COVERAGE, as node copies a missing one into every child. And no
    // NODE_TEST_CONTEXT, with which a node --test inside a test file runs no files.
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: '', FF_TEST_INFLIGHT: path.join(dir, 'inflight.json') };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [WATCHDOG, '--minutes', '0.05', '--', process.execPath, '--test', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', file], {
      encoding: 'utf8',
      env,
      timeout: 50_000,
    });
    assert.equal(r.status, 124, r.stderr);
    assert.match(r.stderr, /WATCHDOG: the run is still going/);
    assert.match(r.stderr, /hang\.test\.ts: running for \d+ s\n\s+waits forever: running for \d+ s/);
    assert.doesNotMatch(r.stderr, /quick: running/, 'a finished test is not listed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watchdog: a run inside its deadline keeps its own exit code', () => {
  const ok = spawnSync(process.execPath, [WATCHDOG, '--minutes', '1', '--', process.execPath, '-e', 'process.exit(3)'], { encoding: 'utf8', env: { ...process.env, NODE_V8_COVERAGE: '' } });
  assert.equal(ok.status, 3);
  const usage = spawnSync(process.execPath, [WATCHDOG, '--', process.execPath], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});
