import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonRpc, loadRpcKey, makeToken, readToken, rpcCall, RpcRefused, RPC_ENV, TOKEN_ENV } from '../machine/daemonRpc.ts';
import { UnitySlots, acquire, reqFile, rpcMailbox, slotRpcHandlers, readSlotPriorities } from '../machine/unitySlots.ts';
import { BenchProxy } from '../machine/benchProxy.ts';
import { benchLockPath, benchQueueDir, queueTickets, trustedBenchScript } from '../machine/benchQueue.ts';
import { benchLockDir, foreignTimedHold, legacyBenchLockDir } from '../machine/benchLock.ts';

// w5545 (item 9 of the w5451 rogue-worker audit): Unity slot requests and bench tickets only through the daemon's own
// calls, keyed to the calling session; files a worker drops in the old folders are no request and no ticket.

const tmp = (t: { after: (fn: () => void) => void }, name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ff-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
};

test('w5545: a token names its session and sandbox; a tampered, re-signed or foreign-key token names nobody', (t) => {
  const dir = tmp(t, 'rpckey');
  const key = loadRpcKey(path.join(dir, 'secrets', 'daemon-rpc.key'));
  assert.equal(key.length, 32);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'secrets', 'daemon-rpc.key')).mode & 0o777, 0o600);
  // Kept across a restart: tokens in running agents stay good.
  assert.deepEqual(loadRpcKey(path.join(dir, 'secrets', 'daemon-rpc.key')), key);
  const tok = makeToken(key, { session: 'w5545-worker', sandbox: 'slot3' });
  assert.deepEqual(readToken(key, tok), { session: 'w5545-worker', sandbox: 'slot3' });
  assert.deepEqual(readToken(key, makeToken(key, { session: 'daemon-biscuit' })), { session: 'daemon-biscuit' });
  const [v, , mac] = tok.split('.');
  const forged = `${v}.${Buffer.from(JSON.stringify({ s: 'release-worker', b: 'slot1' })).toString('base64url')}.${mac}`;
  assert.equal(readToken(key, forged), undefined);
  assert.equal(readToken(Buffer.alloc(32, 7), tok), undefined);
  assert.equal(readToken(key, undefined), undefined);
  assert.equal(readToken(key, 'w5545-worker'), undefined);
  assert.throws(() => makeToken(key, { session: 'a b/../c' }));
});

/** A daemon's rpc with the slot calls on a queue folder, and an arbiter on it looking every 10 ms. */
async function slotDaemon(t: { after: (fn: () => void) => void }) {
  const dir = tmp(t, 'rpcslots');
  const key = loadRpcKey(path.join(dir, 'key'));
  const queue = path.join(dir, 'slot-queue');
  fs.mkdirSync(queue);
  const slots = new UnitySlots({ dir: queue, platform: 'linux', procs: async () => [], alive: () => true, now: () => Date.now(), limit: () => 1, places: () => [], ramPct: () => undefined });
  const rpc = new DaemonRpc({ key, infoFile: path.join(dir, 'rpc.json'), alsoInfoFile: path.join(dir, 'old', 'rpc.json'), handlers: slotRpcHandlers(queue) });
  await rpc.start();
  t.after(() => rpc.close());
  const timer = setInterval(() => void slots.tick().catch(() => undefined), 10);
  t.after(() => {
    clearInterval(timer);
    slots.close();
  });
  await slots.tick();
  const env = (session: string, sandbox?: string): NodeJS.ProcessEnv => ({ [RPC_ENV]: path.join(dir, 'rpc.json'), [TOKEN_ENV]: makeToken(key, { session, ...(sandbox ? { sandbox } : {}) }) });
  return { dir, queue, slots, env };
}

const client = (pid: number, mailbox: ReturnType<typeof rpcMailbox>) => ({ dir: '/nowhere', pid, mailbox, now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), say: () => undefined });

test('w5545: a slot asked through the daemon is filed under the token\'s session and sandbox, whatever the body says, and is granted and released end to end', async (t) => {
  const { queue, env } = await slotDaemon(t);
  const held = await acquire(client(process.pid, rpcMailbox(env('w5545-worker', 'slot3'))), { count: 1, label: 'build', holder: 'sandbox:slot1', session: 'release-worker', pollMs: 10 });
  assert.ok(held.id && !held.ungated, 'granted through the daemon');
  const f = JSON.parse(fs.readFileSync(reqFile(queue, held.id!), 'utf8')) as { holder: string; session: string };
  assert.equal(f.holder, 'sandbox:slot3');
  assert.equal(f.session, 'w5545-worker');
  // Another session cannot look at, touch or release it.
  await assert.rejects(rpcCall('slots/release', { id: held.id }, env('w9999-other', 'slot1')), (e) => e instanceof RpcRefused && e.status === 403);
  await assert.rejects(rpcCall('slots/look', { id: held.id }, env('w9999-other')), (e) => e instanceof RpcRefused && e.status === 403);
  assert.ok(fs.existsSync(reqFile(queue, held.id!)));
  held.stop();
  for (let i = 0; i < 50 && fs.existsSync(reqFile(queue, held.id!)); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(!fs.existsSync(reqFile(queue, held.id!)), 'released through the daemon');
});

test('w5545: a call with no token or a forged one is refused, and files nothing', async (t) => {
  const { dir, queue, env } = await slotDaemon(t);
  const good = env('w5545-worker');
  for (const token of ['', 'v1.e30.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', makeToken(Buffer.alloc(32, 1), { session: 'w5545-worker' })]) {
    await assert.rejects(rpcCall('slots/request', { id: 'abc-1', pid: process.pid, count: 1 }, { ...good, [TOKEN_ENV]: token }), (e) => e instanceof RpcRefused && e.status === 403);
  }
  assert.deepEqual(fs.readdirSync(queue).filter((n) => n.startsWith('req-')), []);
  assert.ok(fs.existsSync(path.join(dir, 'rpc.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'old', 'rpc.json'), 'utf8')).port, JSON.parse(fs.readFileSync(path.join(dir, 'rpc.json'), 'utf8')).port, 'w5546: the old place too, for agents that name it');
});

test('w5545: a request file a worker drops in the old unity-slots mailbox is no request: the arbiter reads only its own queue', async (t) => {
  const root = tmp(t, 'forgedslot');
  const mailbox = path.join(root, 'unity-slots');
  const queue = path.join(root, 'daemon', 'slot-queue');
  fs.mkdirSync(mailbox, { recursive: true });
  fs.mkdirSync(queue, { recursive: true });
  fs.writeFileSync(path.join(mailbox, 'req-forged-1.json'), JSON.stringify({ v: 1, id: 'forged-1', pid: process.pid, holder: 'sandbox:slot1', count: 4, label: 'forged', session: 'release-worker', createdAt: new Date(0).toISOString() }));
  const slots = new UnitySlots({ dir: queue, platform: 'linux', procs: async () => [], alive: () => true, now: () => Date.now(), limit: () => 1, places: () => [], ramPct: () => undefined });
  t.after(() => slots.close());
  await slots.tick();
  assert.deepEqual((await slots.holds()).reqs, []);
  assert.ok(!fs.existsSync(path.join(mailbox, 'grant-forged-1.json')));
  assert.ok(!fs.existsSync(path.join(mailbox, 'arbiter.json')), 'no arbiter in the old mailbox: an old client there runs ungated, counted as a process');
});

test('w5545: a ticket or priorities.json a worker writes in the old tmp/bench.queue is ignored: the queue is under the daemon\'s folder', (t) => {
  const root = tmp(t, 'forgedbench');
  assert.equal(benchLockDir(root), path.join(root, 'daemon', 'bench.lock'));
  assert.equal(benchLockPath(root, {}), benchLockDir(root));
  const old = benchQueueDir(legacyBenchLockDir(root));
  assert.equal(old, path.join(root, 'tmp', 'bench.queue'));
  fs.mkdirSync(path.join(old, 't00000001'), { recursive: true });
  const granted = { at: new Date().toISOString(), ts: Date.now() / 1000 };
  fs.writeFileSync(path.join(old, 't00000001', 'info.json'), JSON.stringify({ ticket: 't00000001', mode: 'exclusive', what: 'forged timing', pid: process.pid, session: 'w9999-other', granted, reason: 'timing' }));
  fs.writeFileSync(path.join(old, 't00000001', 'granted'), JSON.stringify(granted));
  fs.writeFileSync(path.join(old, 'priorities.json'), JSON.stringify({ at: new Date().toISOString(), sessions: { 'w9999-other': { priority: 'urgent', level: 'release' } } }));
  assert.deepEqual(queueTickets(benchLockPath(root, {})!, () => true), []);
  assert.equal(foreignTimedHold(root, 'w5545-worker', Date.now(), () => true), undefined);
  assert.equal(readSlotPriorities(root)('w9999-other'), 'low');
  // The control: the same files in the daemon's own queue count.
  fs.cpSync(old, benchQueueDir(benchLockDir(root)), { recursive: true });
  assert.equal(queueTickets(benchLockPath(root, {})!, () => true).length, 1);
  assert.match(foreignTimedHold(root, 'w5545-worker', Date.now(), () => true) ?? '', /w9999-other/);
  assert.equal(readSlotPriorities(root)('w9999-other'), 'frantic');
});

test('w5545: the bench proxy keys a ticket to the token\'s session, lets only that session use it, and stops a revoked owner only when it runs under that session', async (t) => {
  const root = tmp(t, 'benchproxy');
  const sb = path.join(root, 'sandboxes', 'slot3');
  fs.mkdirSync(path.join(sb, 'scripts', 'bench'), { recursive: true });
  fs.writeFileSync(path.join(sb, 'scripts', 'bench', 'bench_queue.py'), 'RULES_VERSION = 9\n# "--place"\n');
  const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const proxy = new BenchProxy({
    dir: path.join(root, 'daemon', 'bench-holds'),
    lock: () => benchLockDir(root),
    root,
    sandboxPath: (id) => (id === 'slot3' ? sb : undefined),
    alive: () => true,
    sessionOf: async (pid) => (pid === 4242 ? 'w5545-worker' : 'w9999-other'),
    spawnHelper: (_py, args, o) => (spawned.push({ args, env: o.env }), { pid: 777, onExit: () => undefined }),
  });
  const h = proxy.handlers();
  const me = { session: 'w5545-worker', sandbox: 'slot3' };
  const a = (await h['bench/take'](me, { mode: 'exclusive', what: 'timing x', ownerPid: 4242, ownerKind: 'script', reason: 'timing' })) as { handle: string; ownerKind: string };
  assert.equal(a.ownerKind, 'script');
  const args = spawned[0].args;
  assert.equal(args[args.indexOf('--lock') + 1], benchLockDir(root));
  assert.equal(spawned[0].env.FF_SESSION_ID, 'w5545-worker');
  assert.equal(spawned[0].env.FF_SANDBOX_ID, 'slot3');
  assert.equal(spawned[0].env[TOKEN_ENV], undefined);
  // An owner process of another session: the helper may not stop it on a revoke.
  const b = (await h['bench/take'](me, { mode: 'shared', what: 'build', ownerPid: 5151, ownerKind: 'script' })) as { ownerKind: string };
  assert.equal(b.ownerKind, 'service');
  assert.equal(spawned[1].args[spawned[1].args.indexOf('--owner-kind') + 1], 'service');
  // Only its session may read, release or register on the handle.
  const other = { session: 'w9999-other', sandbox: 'slot1' };
  for (const op of ['bench/state', 'bench/release', 'bench/register']) {
    await assert.rejects(async () => h[op](other, { handle: a.handle, pid: 1 }), (e) => e instanceof RpcRefused && e.status === 403, op);
  }
  assert.equal(((await h['bench/state'](me, { handle: a.handle })) as { kind: string }).kind, 'waiting');
  await assert.rejects(async () => h['bench/state'](me, { handle: 'h0000000000000000' }), (e) => e instanceof RpcRefused && e.status === 404);
  // A game player inside a ticket registers by the ticket's name: only a held ticket of the caller's own session.
  const q = benchQueueDir(benchLockDir(root));
  const ticket = (name: string, session: string) => {
    fs.mkdirSync(path.join(q, name), { recursive: true });
    fs.writeFileSync(path.join(q, name, 'info.json'), JSON.stringify({ ticket: name, mode: 'exclusive', what: 'x', pid: process.pid, session }));
    fs.writeFileSync(path.join(q, name, 'granted'), JSON.stringify({ at: 'x', ts: Date.now() / 1000 }));
  };
  ticket('t00000007', 'w5545-worker');
  ticket('t00000008', 'w9999-other');
  assert.deepEqual(await h['bench/register'](me, { ticket: 't00000007', pid: 31337 }), { ticket: 't00000007' });
  assert.match(fs.readFileSync(path.join(q, 't00000007', 'pids'), 'utf8'), /^31337 /);
  await assert.rejects(async () => h['bench/register'](me, { ticket: 't00000008', pid: 31337 }), (e) => e instanceof RpcRefused && e.status === 403);
  await assert.rejects(async () => h['bench/register'](me, { ticket: 't00000009', pid: 31337 }), (e) => e instanceof RpcRefused && e.status === 404);
  assert.ok(!fs.existsSync(path.join(q, 't00000008', 'pids')));
});

test('w5545 with w5572: the bench proxy runs the daemon\'s trusted copy of bench_queue.py with -s, never the caller\'s sandbox copy', async (t) => {
  const root = tmp(t, 'benchproxy-trusted');
  const sb = path.join(root, 'sandboxes', 'slot3');
  fs.mkdirSync(path.join(sb, 'scripts', 'bench'), { recursive: true });
  fs.writeFileSync(path.join(sb, 'scripts', 'bench', 'bench_queue.py'), 'RULES_VERSION = 999\n# planted\n');
  const appDir = path.join(root, 'daemon');
  const spawned: { py: string; args: string[]; cwd?: string }[] = [];
  const proxy = new BenchProxy({
    dir: path.join(appDir, 'bench-holds'),
    trusted: { appDir, fetch: () => ({ text: 'RULES_VERSION = 8\n# trusted\n' }) },
    lock: () => benchLockDir(root),
    root,
    sandboxPath: (id) => (id === 'slot3' ? sb : undefined),
    alive: () => true,
    sessionOf: async () => undefined,
    spawnHelper: (py, args, o) => (spawned.push({ py, args, cwd: o.cwd }), { pid: 778, onExit: () => undefined }),
  });
  await proxy.handlers()['bench/take']({ session: 'w5545-worker', sandbox: 'slot3' }, { mode: 'shared', what: 'build', ownerPid: process.pid });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args[0], '-s');
  assert.equal(spawned[0].args[1], trustedBenchScript(appDir));
  assert.equal(spawned[0].cwd, path.dirname(trustedBenchScript(appDir)));
  assert.ok(!spawned[0].args.some((a) => a.startsWith(sb)), spawned[0].args.join(' '));
});
