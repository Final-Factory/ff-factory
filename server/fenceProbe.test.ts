import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeFence, type ProbeRun } from '../machine/fenceProbe.ts';

// w5377: a write fence that cannot run a no-op is left off, so agents run unfenced and the daemon keeps working.

const fake = (r: ReturnType<ProbeRun>): ProbeRun => () => r;

test('a fence whose no-op exits 0 applies', () => {
  assert.deepEqual(probeFence(['sandbox-exec', '-p', '(version 1)', '/usr/bin/true'], { run: fake({ status: 0 }) }), { ok: true });
});

test('a launcher that exits non-zero (Landlock missing: 125, a refused profile: 65) leaves the fence off and says why', () => {
  const r = probeFence(['python3', 'ff-landlock.py', '--', '/bin/true'], { run: fake({ status: 125, stderr: 'line1\nff-landlock: this kernel has no Landlock\n' }) });
  assert.equal(r.ok, false);
  assert.match(r.why ?? '', /exited 125/);
  assert.match(r.why ?? '', /no Landlock/);
});

test('a launcher that cannot start or hangs leaves the fence off', () => {
  assert.equal(probeFence(['python3'], { run: fake({ status: null, error: new Error('spawn python3 ENOENT') }) }).ok, false);
  const hung = probeFence(['x'], { run: fake({ status: null, signal: 'SIGTERM' }) });
  assert.equal(hung.ok, false);
  assert.match(hung.why ?? '', /SIGTERM/);
});

test('the probe never throws, even when the runner does', () => {
  const r = probeFence(['x'], {
    run: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(r, { ok: false, why: 'probe failed: boom' });
  assert.equal(probeFence([]).ok, false);
});

test('a real command that does not exist is a failed probe, not a crash', () => {
  assert.equal(probeFence(['ff-no-such-launcher-w5377', '--version'], { timeoutMs: 5000 }).ok, false);
});
