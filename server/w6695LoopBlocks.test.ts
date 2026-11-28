/**
 * w6695: the daemon-loop blocks w6674's hour on BEAST still found after w6639: a host command appended on the loop (59.2 s
 * under "link stop"), the Unity slots arbiter's writes in its look (14.7 s), the transcript tail's reopen on the poll timer
 * (6.9 s, 7.9 s) and slots/touch. Each now runs off the loop, in the same order, with the same files afterwards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { HostedSession, LineTail, type HostDeps } from '../machine/agentHost.ts';
import { UnitySlots } from '../machine/unitySlots.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import type { FromDaemon } from './machineProtocol.ts';
import type { SessionInfo } from '../shared/types.ts';

const tmp = (t: { after: (f: () => void) => void }, name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `w6695-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return dir;
};

const PROBES: Probes = {
  stats: async () => ({}) as Awaited<ReturnType<Probes['stats']>>,
  usage: async () => ({ account: { email: 'someone@example.com', plan: 'Claude Max' }, reply: { subscription_type: 'max', rate_limits_available: false } }) as Awaited<ReturnType<Probes['usage']>>,
};

const until = async (what: string, cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const info = (id: string): SessionInfo => ({ id, title: id, model: 'm', permissionMode: 'default', status: 'idle', createdAt: new Date().toISOString(), cwd: '.' }) as unknown as SessionInfo;

/** A hosted session whose host "starts" with a pid the thread answers (no process runs). */
function hosted(root: string) {
  const out: FromDaemon[] = [];
  const logs: string[] = [];
  const deps: HostDeps = {
    root,
    out: (m) => out.push(m),
    events: new EventEmitter(),
    handlers: () => ({}),
    spec: () => ({ cwd: root }) as never,
    editorUp: () => undefined,
    changed: () => undefined,
    log: (l) => logs.push(l),
    launch: () => Promise.resolve(999_999),
  };
  const s = new HostedSession(info('h1'), 0, deps);
  const inFile = () => path.join(root, 'h1', 'in.jsonl');
  const ops = () => {
    try {
      return fs.readFileSync(inFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { op: string }).op);
    } catch {
      return [];
    }
  };
  return { s, out, logs, inFile, ops };
}

/** The synchronous appends to `file` while patched. */
function syncAppends(t: { after: (f: () => void) => void }, file: () => string) {
  const real = fs.appendFileSync;
  const seen: string[] = [];
  fs.appendFileSync = ((p: fs.PathOrFileDescriptor, d: string | Uint8Array, o?: fs.WriteFileOptions) => {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(file())) seen.push(String(d));
    return real(p, d, o);
  }) as typeof fs.appendFileSync;
  const restore = () => void (fs.appendFileSync = real);
  t.after(restore);
  return { seen, restore };
}

/** fs.promises.appendFile held until released (the first call only). */
function heldAppend(t: { after: (f: () => void) => void }) {
  const real = fs.promises.appendFile;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  fs.promises.appendFile = (async (...a: Parameters<typeof real>) => {
    if (held++ === 0) await gate;
    return real(...a);
  }) as typeof real;
  const restore = () => void (fs.promises.appendFile = real);
  t.after(restore);
  return { release: () => release(), held: () => held, restore };
}

test('w6695: commands to a running host (a stop, a decision) are appended off the loop, in order after the first', { timeout: 20_000 }, async (t) => {
  const root = tmp(t, 'cmd');
  const h = hosted(root);
  t.after(() => h.s.detach());
  h.s.send('hello', 'orchestrator');
  assert.deepEqual(h.ops(), ['send'], "a new host's first command is in in.jsonl before the host starts, as before");
  const sync = syncAppends(t, h.inFile);
  h.s.decide('r1', true);
  h.s.stop();
  sync.restore();
  assert.deepEqual(sync.seen, [], 'a stop was appended to in.jsonl on the loop (59.2 s on BEAST, 2026-11-28 04:38Z)');
  await until('the commands landed', () => h.ops().length === 3);
  assert.deepEqual(h.ops(), ['send', 'decide', 'stop']);
  const ns = fs.readFileSync(h.inFile(), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { n: number }).n);
  assert.deepEqual(ns, [1, 2, 3]);
});

test("w6695: a message for a new host waits until the old host's last commands are appended, then starts it", { timeout: 20_000 }, async (t) => {
  const root = tmp(t, 'wait');
  const h = hosted(root);
  t.after(() => h.s.detach());
  h.s.send('one', 'orchestrator');
  const gate = heldAppend(t);
  h.s.stop();
  // Its host closed meanwhile (as the host's own close would say): the next message starts a new host.
  (h.s as unknown as { running: boolean }).running = false;
  const rmSync = fs.rmSync;
  let removed = 0;
  fs.rmSync = ((p: fs.PathLike, o?: fs.RmOptions) => (removed++, rmSync(p, o))) as typeof fs.rmSync;
  t.after(() => void (fs.rmSync = rmSync));
  h.s.send('two', 'orchestrator');
  assert.equal(gate.held(), 1, "the old host's stop is being appended off the loop");
  assert.equal(removed, 0, "the new host's folder was made under the old host's command still being appended");
  gate.release();
  await until('the new host started', () => removed > 0 && h.ops().length === 1);
  gate.restore();
  fs.rmSync = rmSync;
  assert.deepEqual(h.ops(), ['send'], 'the new host reads only its own message');
  assert.equal((JSON.parse(fs.readFileSync(h.inFile(), 'utf8').trim()) as { text: string }).text, 'two');
});

test('w6695: on detach, commands behind an append under way still land, in order (the daemon waits for them, w6703)', { timeout: 20_000 }, async (t) => {
  const root = tmp(t, 'detach');
  const h = hosted(root);
  h.s.send('one', 'orchestrator');
  const gate = heldAppend(t);
  h.s.decide('r1', true); // being appended, held
  h.s.stop(); // queued behind it
  h.s.detach();
  assert.deepEqual(h.ops(), ['send'], 'the queued stop jumped ahead of the decide still being appended');
  let written = false;
  void h.s.flushed().then(() => (written = true));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(written, false, 'flushed() resolved with a command still being appended');
  gate.release();
  await until('both landed', () => written);
  gate.restore();
  assert.deepEqual(h.ops(), ['send', 'decide', 'stop']);
});

test("w6695: an exiting daemon waits for its hosts' commands still being appended, up to its cap (w6703)", { timeout: 20_000 }, async (t) => {
  const root = tmp(t, 'exit');
  const d = new Daemon({ portalUrl: 'http://127.0.0.1:1', id: 'mx', token: 't', repoPath: root, appDir: root, tempDir: path.join(root, 'tmp'), maxEventsFile: null }, () => {
    throw new Error('no sessions here');
  }, PROBES);
  const h = hosted(root);
  t.after(() => h.s.detach());
  (d as unknown as { entries: Map<string, { s: unknown }> }).entries.set('h1', { s: h.s });
  h.s.send('one', 'orchestrator');
  const gate = heldAppend(t);
  h.s.stop();
  d.shutdown();
  let exited = false;
  void d.exitWhenWritten().then(() => (exited = true));
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(exited, false, 'the daemon exits 500 ms after shutdown with a stop still being appended, and the stop is lost');
  gate.release();
  await until('it exits', () => exited);
  assert.deepEqual(h.ops(), ['send', 'stop']);
  // A write that never ends holds the exit only up to the cap.
  const t0 = Date.now();
  await d.hostCommandsWritten.call({ entries: new Map([['x', { s: Object.assign(Object.create(HostedSession.prototype), { flushed: () => new Promise(() => undefined) }) }]]) } as never, 200);
  assert.ok(Date.now() - t0 < 2000);
});

test("w6695: the poll timer's tail opens its file again off the loop and reads on the next poll; a forced poll still opens it at once", { timeout: 20_000 }, async (t) => {
  const dir = tmp(t, 'tail');
  const file = path.join(dir, 'out.jsonl');
  fs.writeFileSync(file, 'one\n');
  const lines: string[] = [];
  const tail = new LineTail(file, (l) => lines.push(l), 0, 2000);
  t.after(() => tail.close());
  const openSync = fs.openSync;
  let opens = 0;
  fs.openSync = ((...a: Parameters<typeof openSync>) => (opens++, openSync(...a))) as typeof openSync;
  t.after(() => void (fs.openSync = openSync));
  tail.poll(true);
  assert.equal(opens, 0, "the poll timer's tail opened out.jsonl on the loop (6.9 s and 7.9 s on BEAST, 2026-11-28 04:28Z)");
  assert.deepEqual(lines, []);
  await until('the handle opened', () => tail.closing === 0);
  tail.poll(true);
  assert.deepEqual(lines, ['one']);
  assert.equal(opens, 0);
  // Let go of while an open is under way: what it opens is closed, not kept.
  tail.close();
  tail.poll(true);
  assert.equal(tail.closing, 1, 'an open under way counts as a handle a folder removal must wait for');
  tail.close();
  await until('the late handle closed', () => tail.closing === 0);
  assert.equal((tail as unknown as { fd?: number }).fd, undefined);
  // A forced poll (adopting a host, one that has gone) reads now, as before.
  fs.appendFileSync(file, 'two\n');
  tail.poll();
  assert.deepEqual(lines, ['one', 'two']);
  assert.equal(opens, 1);
  fs.openSync = openSync;
});

test("w6695: the Unity slots arbiter's look writes arbiter.json off the loop, whole", async (t) => {
  const dir = tmp(t, 'slots');
  const slots = new UnitySlots({ dir, platform: 'linux', procs: async () => [], alive: () => true, now: () => Date.now(), limit: () => 1, places: () => [], ramPct: () => undefined });
  t.after(() => slots.close());
  const writeFileSync = fs.writeFileSync;
  const syncWrites: string[] = [];
  fs.writeFileSync = ((p: fs.PathOrFileDescriptor, ...a: unknown[]) => {
    if (typeof p === 'string' && path.resolve(p).startsWith(path.resolve(dir))) syncWrites.push(p);
    return (writeFileSync as (...x: unknown[]) => void)(p, ...a);
  }) as typeof fs.writeFileSync;
  t.after(() => void (fs.writeFileSync = writeFileSync));
  await slots.tick();
  fs.writeFileSync = writeFileSync;
  assert.deepEqual(syncWrites, [], "the arbiter's look wrote on the loop (14.7 s on BEAST, 2026-11-28 04:28Z)");
  const names = fs.readdirSync(dir);
  assert.ok(names.includes('arbiter.json'), names.join(', '));
  assert.deepEqual(names.filter((n) => n.endsWith('.tmp')), [], 'no temporary file is left');
  assert.ok((JSON.parse(fs.readFileSync(path.join(dir, 'arbiter.json'), 'utf8')) as { pid?: number }).pid === process.pid);
});

test("w6695: a twin arbiter's arbiter.json written while the look writes its own is seen before it is replaced", async (t) => {
  const dir = tmp(t, 'twin');
  const events: string[] = [];
  const slots = new UnitySlots({ dir, platform: 'win32', procs: async () => [], alive: () => true, now: () => Date.now(), limit: () => 1, places: () => [], ramPct: () => undefined, onEvent: (e) => void events.push(e) });
  t.after(() => slots.close());
  await slots.tick();
  const rogue = new UnitySlots({ dir, platform: 'win32', procs: async () => [], alive: () => true, now: () => Date.now(), limit: () => undefined, places: () => [], ramPct: () => undefined, machine: 'mx' });
  t.after(() => rogue.close());
  // The rogue's look lands while this arbiter's arbiter.json is being written (a slow disk: 14.7 s on BEAST).
  const real = fs.promises.writeFile;
  let once = false;
  fs.promises.writeFile = (async (...a: Parameters<typeof real>) => {
    if (!once && /arbiter\.json\..*\.tmp$/.test(String(a[0]))) {
      once = true;
      fs.promises.writeFile = real;
      await rogue.tick();
    }
    return real(...a);
  }) as typeof real;
  t.after(() => void (fs.promises.writeFile = real));
  await slots.tick();
  assert.equal(once, true);
  assert.equal(events.filter((e) => e.startsWith('another process')).length, 1, "the twin's file was replaced unseen");
});
