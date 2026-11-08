import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { holdsOwnTicket, isHarnessTicket, REVOKE_KILL_GRACE_MS, revokeTicket, sessionMatches, type RevokeDeps } from '../machine/benchRevoke.ts';
import type { QueueTicket } from '../machine/benchQueue.ts';

const SESSION = 'abcd1234-aaaa-bbbb-cccc-000000000001';
const NOW = Date.parse('2026-11-08T12:00:00Z');

const roots: string[] = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** A worker root with one ticket folder, as bench_queue.py writes it. */
function setup(t: { name?: string; info?: Record<string, unknown>; granted?: boolean; revoked?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revoke-'));
  roots.push(root);
  const name = t.name ?? 't00000042';
  const dir = path.join(root, 'tmp', 'bench.queue', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify({ pid: 4242, owner_pid: 4000, session: SESSION, what: 'player build', mode: 'exclusive', ...t.info }));
  if (t.granted !== false) fs.writeFileSync(path.join(dir, 'granted'), JSON.stringify({ at: 'x', ts: NOW / 1000 }));
  if (t.revoked) fs.writeFileSync(path.join(dir, 'revoked'), JSON.stringify({ at: 'x', ts: 1 }));
  return { root, dir, name };
}

/** Fake deps: timers collected, nothing real killed. */
function fakes(alive: (pid: number) => boolean = () => true) {
  const lines: string[] = [];
  const killed: number[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const deps: RevokeDeps = {
    now: () => NOW,
    alive,
    kill: async (pid) => void killed.push(pid),
    setTimeout: (fn, ms) => void timers.push({ fn, ms }),
    log: (l) => void lines.push(l),
  };
  return { deps, lines, killed, timers };
}

const msg = (ticket: string, session = SESSION) => ({ ticket, session, why: 'its worker is idle' });

test('revokeTicket writes revoked with limit true and ends nothing before the grace', () => {
  const { root, dir, name } = setup();
  const f = fakes();
  const out = revokeTicket(root, msg(name), f.deps);
  assert.equal(out, `revoked ${name}`);
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'revoked'), 'utf8'));
  assert.deepEqual(r, { at: new Date(NOW).toISOString(), ts: NOW / 1000, by: 'ff-factory', limit: true, why: 'its worker is idle' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['granted', 'info.json', 'revoked'], 'no temp file is left');
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].ms, REVOKE_KILL_GRACE_MS);
  assert.equal(REVOKE_KILL_GRACE_MS, 90_000);
  assert.deepEqual(f.killed, []);
  assert.ok(f.lines.every((l) => l.includes(name)));
});

test('revokeTicket accepts a session id that starts with the ticket\'s', () => {
  const { root, name } = setup({ info: { session: SESSION.slice(0, 8) } });
  assert.equal(revokeTicket(root, msg(name), fakes().deps), `revoked ${name}`);
});

test('revokeTicket refuses what it must not touch, and writes nothing', () => {
  const cases: { why: RegExp; setup: Parameters<typeof setup>[0]; msg?: (name: string) => ReturnType<typeof msg> }[] = [
    { why: /^refused: it is session/, setup: {}, msg: (n) => msg(n, 'ffff0000-other') },
    { why: /^refused: it is session/, setup: {}, msg: (n) => msg(n, '') },
    { why: /harness ticket/, setup: { info: { what: 'timed run abc: leg' } } },
    { why: /harness ticket/, setup: { info: { session: '', what: 'running editor sb1' } } },
    { why: /not granted/, setup: { granted: false } },
    { why: /already revoked/, setup: { revoked: true } },
    { why: /no helper process/, setup: { info: { pid: 0 } } },
    { why: /no helper process/, setup: { info: { pid: process.pid } } },
  ];
  for (const c of cases) {
    const { root, dir, name } = setup(c.setup);
    const f = fakes();
    const out = revokeTicket(root, c.msg ? c.msg(name) : msg(name), f.deps);
    assert.match(out, c.why);
    assert.equal(f.timers.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'revoked')), !!c.setup?.revoked);
    assert.equal(f.lines.length, 1);
  }
  // a bad name never reaches the disk, and a ticket that is not there is refused
  for (const bad of ['', 't1', '../t00000042', 't00000042/..', 'T00000042', 't000000421']) {
    const { root } = setup();
    const f = fakes();
    assert.match(revokeTicket(root, msg(bad), f.deps), /not a ticket name/, bad);
    assert.equal(f.timers.length, 0);
  }
  const { root } = setup();
  assert.match(revokeTicket(root, msg('t00000099'), fakes().deps), /no such ticket/);
});

test('after the grace the helper pid is ended when the folder remains, and only that pid', async () => {
  const { root, name } = setup({ info: { pid: 4242, owner_pid: 4000 } });
  const f = fakes();
  revokeTicket(root, msg(name), f.deps);
  f.timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.killed, [4242], 'the helper, not the owner pid');
  assert.ok(f.lines.some((l) => /ended helper pid 4242/.test(l)));
});

test('after the grace nothing is ended when the folder is gone, the helper is gone, or the pid changed', async () => {
  const gone = setup();
  const g = fakes();
  revokeTicket(gone.root, msg(gone.name), g.deps);
  fs.rmSync(gone.dir, { recursive: true });
  g.timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(g.killed, []);
  assert.ok(g.lines.some((l) => /gone after its grace/.test(l)));

  const dead = setup();
  const d = fakes(() => false);
  revokeTicket(dead.root, msg(dead.name), d.deps);
  d.timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(d.killed, []);

  // a new ticket reusing the folder name with another helper is not ours to end
  const reused = setup();
  const r = fakes();
  revokeTicket(reused.root, msg(reused.name), r.deps);
  fs.writeFileSync(path.join(reused.dir, 'info.json'), JSON.stringify({ pid: 9999, session: SESSION, what: 'x' }));
  r.timers[0].fn();
  await new Promise((x) => setImmediate(x));
  assert.deepEqual(r.killed, []);
});

test('a failed end of the helper is logged, not thrown', async () => {
  const { root, name } = setup();
  const f = fakes();
  f.deps.kill = async () => {
    throw new Error('access denied');
  };
  revokeTicket(root, msg(name), f.deps);
  f.timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.ok(f.lines.some((l) => /failed: access denied/.test(l)));
});

test('holdsOwnTicket: granted, not revoked, a worker\'s own; a harness ticket never counts', () => {
  const t = (o: Partial<QueueTicket>): QueueTicket => ({ ticket: 't00000001', mode: 'exclusive', what: 'player build', pid: 1, session: SESSION, granted: { at: 'x', ts: 1 }, ...o });
  assert.equal(holdsOwnTicket([t({})], SESSION), true);
  assert.equal(holdsOwnTicket([t({ session: SESSION.slice(0, 8) })], SESSION), true);
  assert.equal(holdsOwnTicket([t({ granted: undefined })], SESSION), false, 'waiting holds nothing');
  assert.equal(holdsOwnTicket([t({ revoked: { at: 'x', why: 'y' } })], SESSION), false);
  assert.equal(holdsOwnTicket([t({ what: 'timed run r1: leg' })], SESSION), false);
  assert.equal(holdsOwnTicket([t({ session: undefined })], SESSION), false);
  assert.equal(holdsOwnTicket([t({ session: 'someone-else' })], SESSION), false);
  assert.equal(isHarnessTicket({ session: '', what: 'running editor x' }), true);
  assert.equal(sessionMatches('', SESSION), false);
});
