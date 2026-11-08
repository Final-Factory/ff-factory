// w3731: a daemon restart between a revoke and its grace timer must not leave a helper that ignored its `revoked` file
// holding the bench ticket: the new daemon's start rescans the queue (machine/benchRevoke.ts resumeRevokes).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REVOKE_KILL_GRACE_MS, resumeRevokes, revokeTicket, type RevokeDeps } from '../machine/benchRevoke.ts';

const SESSION = 'abcd1234-aaaa-bbbb-cccc-000000000001';
const NOW = Date.parse('2026-11-08T12:00:00Z');

const roots: string[] = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const root = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'revoke-restart-'));
  roots.push(r);
  return r;
};

/** One ticket folder as bench_queue.py writes it; `revokedTs` (epoch ms) writes a revoked file. */
function ticket(r: string, name: string, t: { info?: Record<string, unknown>; revokedTs?: number; revokedRaw?: string } = {}) {
  const dir = path.join(r, 'tmp', 'bench.queue', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify({ pid: 4242, session: SESSION, what: 'probe A/B', mode: 'exclusive', ...t.info }));
  fs.writeFileSync(path.join(dir, 'granted'), JSON.stringify({ at: 'x', ts: NOW / 1000 - 600 }));
  if (t.revokedTs !== undefined) fs.writeFileSync(path.join(dir, 'revoked'), JSON.stringify({ at: 'x', ts: t.revokedTs / 1000, by: 'ff-factory', limit: true, why: 'idle' }));
  if (t.revokedRaw !== undefined) fs.writeFileSync(path.join(dir, 'revoked'), t.revokedRaw);
  return dir;
}

function fakes(now: number, alive: (pid: number) => boolean = () => true) {
  const lines: string[] = [];
  const killed: number[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const deps: RevokeDeps = { now: () => now, alive, kill: async (pid) => void killed.push(pid), setTimeout: (fn, ms) => void timers.push({ fn, ms }), log: (l) => void lines.push(l) };
  return { deps, lines, killed, timers };
}

const settle = () => new Promise((r) => setImmediate(r));

test('w3731: a revoke whose daemon restarted before its grace timer still ends the helper that ignored it', async () => {
  const r = root();
  ticket(r, 't00000042');
  // The daemon before the restart revokes; its timer is lost with it (never run).
  const before = fakes(NOW);
  assert.equal(revokeTicket(r, { ticket: 't00000042', session: SESSION, why: 'its worker is idle' }, before.deps), 'revoked t00000042');
  assert.equal(before.timers.length, 1);
  // The new daemon starts 2 minutes later: past the grace, the helper still runs, so its tree ends now.
  const afterRestart = fakes(NOW + 120_000);
  const out = resumeRevokes(r, afterRestart.deps);
  await settle();
  assert.deepEqual(afterRestart.killed, [4242]);
  assert.equal(out.length, 1);
  assert.match(out[0], /t00000042/);
  assert.ok(afterRestart.lines.some((l) => /ended helper pid 4242/.test(l)));
});

test('w3731: a revoke younger than the grace gets its timer back for what is left of it', async () => {
  const r = root();
  ticket(r, 't00000001', { revokedTs: NOW - 30_000 });
  const f = fakes(NOW);
  resumeRevokes(r, f.deps);
  assert.deepEqual(f.killed, []);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].ms, REVOKE_KILL_GRACE_MS - 30_000);
  f.timers[0].fn();
  await settle();
  assert.deepEqual(f.killed, [4242]);
});

test('w3731: a revoked file without a readable ts counts from its mtime', async () => {
  const r = root();
  const dir = ticket(r, 't00000002', { revokedRaw: '{}' });
  const old = new Date(NOW - 10 * 60_000);
  fs.utimesSync(path.join(dir, 'revoked'), old, old);
  const f = fakes(NOW);
  resumeRevokes(r, f.deps);
  await settle();
  assert.deepEqual(f.killed, [4242]);
});

test('w3731: the rescan never touches a harness ticket, a ticket not revoked, a dead helper or no helper', async () => {
  const r = root();
  const old = NOW - 10 * 60_000;
  ticket(r, 't00000010', { info: { what: 'timed run abc: leg A', pid: 5001 }, revokedTs: old });
  ticket(r, 't00000011', { info: { session: '', what: 'running editor sb1', pid: 5002 }, revokedTs: old });
  ticket(r, 't00000012', { info: { pid: 5003 } });
  ticket(r, 't00000013', { info: { pid: 5004 }, revokedTs: old });
  ticket(r, 't00000014', { info: { pid: 0 }, revokedTs: old });
  ticket(r, 't00000015', { info: { pid: process.pid }, revokedTs: old });
  fs.mkdirSync(path.join(r, 'tmp', 'bench.queue', 'not-a-ticket'), { recursive: true });
  const f = fakes(NOW, (pid) => pid !== 5004);
  assert.deepEqual(resumeRevokes(r, f.deps), []);
  await settle();
  assert.deepEqual(f.killed, []);
  assert.equal(f.timers.length, 0);
});

test('w3731: a machine with no bench queue folder rescans nothing', () => {
  const f = fakes(NOW);
  assert.deepEqual(resumeRevokes(root(), f.deps), []);
  assert.deepEqual(f.lines, []);
});
