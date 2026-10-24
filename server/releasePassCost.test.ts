import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PlaceAgain } from './placeAgain.ts';
import { workByWorker } from './agents.ts';
import { resumableSessions, ownersOf } from './resumable.ts';
import { isWith } from '../shared/blockers.ts';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { gzipFile } from './dataGuard.ts';
import type { Config } from './config.ts';
import type { Machine, MachineSandbox, SessionInfo } from '../shared/types.ts';

/**
 * w2026: what the portal's own stall profiles named on 2026-10-24 (735683ea0, rolled back at 11:37Z after missing /api/health
 * for 300 s), pinned against the grown shape. CI runs no timing tests (CONTRIBUTING.md "Performance"), so these count the work:
 *  - the release pass (PlaceAgain.tick, every minute) computed a machine's claims again for every released worker, each time
 *    reading every session and sorting every waiting worker (tick > claimedBy > claims > facts: 30-37 s of every minute);
 *  - the first daemon connects after the start unzipped each compressed transcript of their sessions whole, synchronously, and
 *    wrote its tail file (attach > lastSeq > writeFileSync: 39 s).
 */

const NOW = Date.parse('2026-10-24T11:35:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

test('w2026: a release pass reads a machine\'s sessions and sorts its waiting workers once, however many workers were released', () => {
  const released = 80;
  const sessions: SessionInfo[] = [];
  for (let i = 0; i < released; i++) sessions.push({ id: `r${i}`, kind: 'worker', machineId: 'pc', machineSandbox: `slot${(i % 3) + 1}`, title: `w${i}: x`, status: 'stopped', permissionMode: 'default', createdAt: iso(NOW - 86_400_000), lastActivityAt: iso(NOW - 3_600_000), turns: 1, costUsd: 0, pendingPermissions: [], placeReleased: { at: iso(NOW - 600_000), sandbox: `slot${(i % 3) + 1}`, branch: `feature/r${i}`, why: 'far' } } as SessionInfo);
  for (let i = 0; i < 400; i++) sessions.push({ id: `old${i}`, kind: 'worker', machineId: 'pc', machineSandbox: 'slot1', title: 'done', status: 'stopped', permissionMode: 'default', createdAt: iso(NOW - 9 * 86_400_000), lastActivityAt: iso(NOW - 8 * 86_400_000), turns: 1, costUsd: 0, pendingPermissions: [] } as SessionInfo);
  const sb = (id: string): MachineSandbox => ({ id, branch: `sandbox/${id}`, base: 'origin/master', path: `/sb/${id}`, purpose: id, status: 'ready', createdAt: iso(NOW - 86_400_000), unity: { state: 'stopped' }, sessionIds: [], git: { branch: `sandbox/${id}`, dirty: 0, untracked: 0, at: iso(NOW) } }) as MachineSandbox;
  const machine = { id: 'pc', sandboxes: [sb('slot1'), sb('slot2'), sb('slot3')] } as unknown as Machine;
  let reads = 0;
  let compares = 0;
  const p = new PlaceAgain({
    sessions: () => {
      reads++;
      return sessions;
    },
    machine: () => machine,
    isLive: () => false,
    online: () => true,
    unityHolders: () => [],
    workOver: (s) => (s.id.startsWith('old') ? 'its request is closed (w1 done)' : undefined),
    order: (a, b) => {
      compares++;
      return a.id.localeCompare(b.id);
    },
    keepLive: () => undefined,
    queued: (id) => id.startsWith('r'),
    stopLive: () => undefined,
    stopEditor: async () => undefined,
    switchBranch: async () => ({ notes: [] }),
    save: () => undefined,
    saveMachine: () => undefined,
    note: () => undefined,
    drain: () => undefined,
    now: () => NOW,
  });
  const before = p.claims('pc');
  reads = 0;
  compares = 0;
  p.tick();
  // before w2026: a read of every session and a sort of all 80 waiting workers per released worker (80 of each, 480 sessions read each time)
  assert.ok(reads <= 3, `the pass read the sessions ${reads} times`);
  assert.ok(compares <= released * 8, `the pass compared waiting workers ${compares} times (one sort of ${released} is about ${Math.round(released * Math.log2(released))})`);
  // the same answer as outside a pass, and nothing kept after it
  assert.deepEqual([...p.claims('pc')], [...before]);
  reads = 0;
  p.claims('pc');
  assert.equal(reads, 1, 'outside a pass claims are computed fresh');
});

test('w2026: a daemon connecting is welcomed without unzipping a compressed transcript on the main thread', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-gz-'));
  const cfg = { dataDir: dir, port: 0, limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 }, orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false }, worker: { permissionMode: 'bypassPermissions', effort: 'low' }, unity: {} } as unknown as Config;
  const store = new Store(dir);
  store.putSession({ id: 's1', kind: 'worker', machineId: 'pc', title: 'w1: x', status: 'stopped', permissionMode: 'default', createdAt: iso(NOW), lastActivityAt: iso(NOW), turns: 1, costUsd: 0, pendingPermissions: [] } as SessionInfo);
  for (let i = 0; i < 30; i++) store.append('s1', { kind: 'system', text: `line ${i}` });
  const f = path.join(dir, 'transcripts', 's1.jsonl');
  assert.ok(await gzipFile(f));
  // a .gz compressed before the tail files came (w2026's first deploy): none beside it
  fs.rmSync(`${f}.gz.tail`);
  // the portal starting again: nothing remembered about the transcript
  const fresh = new Store(dir);
  fresh.putSession(store.sessions.get('s1')!);
  fresh.putMachine({ id: 'pc', name: 'pc', platform: 'linux', sessionIds: ['s1'], sandboxes: [], online: false, createdAt: iso(NOW) } as unknown as Machine);
  const machines = new MachineManager(cfg, fresh, new SessionManager(cfg, fresh));
  const sent: { type: string; sessions?: { id: string; lastSeq: number }[] }[] = [];
  const ws = { on: () => undefined, send: (s: string) => void sent.push(JSON.parse(s)), close: () => undefined, readyState: 1 };
  const orig = zlib.gunzipSync;
  let unzips = 0;
  (zlib as { gunzipSync: unknown }).gunzipSync = (...a: unknown[]) => {
    unzips++;
    return (orig as (...x: unknown[]) => unknown)(...a);
  };
  try {
    machines.attach('pc', ws as never);
    assert.equal(unzips, 0, 'no synchronous unzip in attach');
    for (let i = 0; i < 100 && !sent.some((m) => m.type === 'welcome'); i++) await new Promise((r) => setTimeout(r, 10));
    const welcome = sent.find((m) => m.type === 'welcome');
    assert.deepEqual(welcome?.sessions, [{ id: 's1', lastSeq: 30 }]);
    assert.equal(unzips, 0);
    assert.ok(fs.existsSync(`${f}.gz.tail`), 'its tail file is written for the next start');
    assert.equal(new Store(dir).lastSeqNow('s1'), 30, 'the next start answers from the tail file at once');
  } finally {
    (zlib as { gunzipSync: unknown }).gunzipSync = orig;
  }
});

test('w2026: the per-pass index of requests by worker holds every request workOver, ciWait and waitOn can count for that worker', () => {
  const at = iso(NOW);
  const work = Array.from({ length: 300 }, (_, i) => ({
    id: `w${i}`,
    title: 't',
    status: i % 5 === 0 ? 'blocked' : i % 7 === 0 ? 'done' : 'working',
    sessionIds: [`s${i % 40}`, `s${(i * 7) % 40}`],
    links: { [`s${(i * 7) % 40}`]: { at } },
    ...(i % 11 === 0 ? { movedOff: { [`s${(i + 3) % 40}`]: { at, to: 'x' } } } : {}),
    ...(i % 5 === 0 ? { blocked: { kind: 'ci', ref: 'o/r#1', at, by: `worker s${(i + 1) % 45}` } } : {}),
    createdAt: at,
    updatedAt: at,
  })) as never as import('../shared/types.ts').WorkItem[];
  const index = workByWorker(work);
  const sessions = Array.from({ length: 45 }, (_, i) => `s${i}`);
  for (const sid of sessions) {
    const mine = index.get(sid) ?? [];
    // everything a pass may read for it, in ledger order
    assert.deepEqual(mine.map((w) => w.id), work.filter((w) => w.sessionIds.includes(sid) || w.movedOff?.[sid] || isWith(w, sid)).map((w) => w.id), sid);
  }
  // resumable.ts's one-pass forms answer as the scans did
  const items = work.filter((w) => w.status !== 'done');
  assert.deepEqual(resumableSessions(sessions, work, NOW), sessions.filter((sid) => items.some((w) => w.sessionIds.includes(sid) && isWith(w, sid))).sort());
  const owners = ownersOf(sessions.map((id) => ({ id })), work);
  for (const sid of Object.keys(owners)) assert.deepEqual(owners[sid].requests.map((r) => r.id), work.filter((w) => w.sessionIds.includes(sid)).map((w) => w.id.toLowerCase()).sort((a, b) => a.localeCompare(b)), sid);
});

test('w2026: connects after a start unzip one compressed transcript at a time, by a stream, and a big one gets a tail file that is not whole', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unzip-stream-'));
  const tr = path.join(dir, 'transcripts');
  fs.mkdirSync(tr, { recursive: true });
  // 12 MB unzipped: more than a tail file (8 MB)
  const pad = 'x'.repeat(4000);
  const lines: string[] = [];
  for (let i = 1; i <= 3000; i++) lines.push(JSON.stringify({ seq: i, t: iso(NOW), kind: 'system', text: pad }));
  for (const id of ['a', 'b', 'c']) {
    fs.writeFileSync(path.join(tr, `${id}.jsonl`), lines.join('\n') + '\n');
    assert.ok(await gzipFile(path.join(tr, `${id}.jsonl`)));
    fs.rmSync(path.join(tr, `${id}.jsonl.gz.tail`));
  }
  const store = new Store(dir);
  assert.equal(store.lastSeqNow('a'), undefined);
  const orig = zlib.gunzip;
  let inFlight = 0;
  let most = 0;
  const origStat = fs.promises.stat;
  (fs.promises as { stat: unknown }).stat = async (...a: unknown[]) => {
    inFlight++;
    most = Math.max(most, inFlight);
    try {
      return await (origStat as (...x: unknown[]) => Promise<fs.Stats>)(...a);
    } finally {
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    }
  };
  (zlib as { gunzip: unknown }).gunzip = () => assert.fail('no whole-buffer unzip');
  try {
    assert.deepEqual(await Promise.all(['a', 'b', 'c'].map((id) => store.lastSeqAsync(id))), [3000, 3000, 3000]);
  } finally {
    (zlib as { gunzip: unknown }).gunzip = orig;
    (fs.promises as { stat: unknown }).stat = origStat;
  }
  assert.equal(most, 1, 'one unzip at a time');
  const head = JSON.parse(fs.readFileSync(path.join(tr, 'a.jsonl.gz.tail'), 'utf8').split('\n')[0]);
  assert.equal(head.whole, false);
  assert.equal(new Store(dir).lastSeqNow('a'), 3000, 'the next start reads the tail file');
  // and reads only its header and its end, never the whole 8 MB (43c933439's first start: 18 s of readFileSync)
  const origRead = fs.readFileSync;
  let tailReads = 0;
  (fs as { readFileSync: unknown }).readFileSync = (f: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(f).endsWith('.tail')) tailReads++;
    return (origRead as (...x: unknown[]) => unknown)(f, ...rest);
  };
  try {
    const next = new Store(dir);
    assert.equal(next.lastSeqNow('b'), 3000);
    assert.deepEqual(next.readTranscript('c', 3).map((e) => e.seq), [2998, 2999, 3000]);
  } finally {
    (fs as { readFileSync: unknown }).readFileSync = origRead;
  }
  assert.equal(tailReads, 0);
});
