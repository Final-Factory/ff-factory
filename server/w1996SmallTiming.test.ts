// w1996: big computers build, small computers time. lothsahn, 2026-10-24: "figure out how to efficiently use the machines
// with a small number of slots for jobs that do exclusive locks and the machines with a large number of slots to do builds
// and functional runs. We're wasting system resources like crazy locking beast down to a single timing job."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rankTargets, TimedRuns, type TimedTarget } from './timedRuns.ts';
import { checkTimedAsk, decideTimedPlace } from './timedAsk.ts';
import type { Computer } from './placement.ts';
import { borrowPair, linkInto, slotFree, TimedRunner, type RunTicket } from '../machine/timedRunner.ts';
import { hashVariant, scanBuild } from '../machine/timedRunPack.ts';
import type { TicketState } from '../machine/benchQueue.ts';
import { TIMED_DEFAULTS, type TimedRunOrder, type TimedRunReport } from '../shared/timedRun.ts';
import type { AttachmentStore } from './attachments.ts';
import type { Machine } from '../shared/types.ts';

const tmp = (t: { after(fn: () => void): void }, tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const GB = 1024 ** 3;
const box = (id: string, maxAgents: number, platform: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 1, midTurn: 0, maxAgents, sandboxes: 1, maxSandboxes: Math.max(1, Math.ceil(maxAgents / 2)), freeSandboxes: 1, memUsedBytes: 16 * GB, memTotalBytes: 64 * GB, editors: 0, maxEditors: 2, platform, ...o });
const fleet = () => [box('beast', 6, 'win32', { live: 6 }), box('lothdesktop', 10, 'win32', { live: 9 }), box('lothlaptop', 1, 'win32', { live: 1 }), box('m3', 2, 'darwin'), box('biscuit', 4, 'linux'), box('m5', 4, 'darwin', { live: 0, noTimedRuns: 'Ben' })];
const at = (id: string) => fleet().find((c) => c.id === id)!;

test('w1996: timed_run goes to small worker computers too, play-only first, then the fewest runs ahead and agent slots; Windows only', () => {
  const machines = [
    { id: 'beast', platform: 'win32', sandboxRoot: 'F:/ffw/sandboxes' },
    { id: 'lothlaptop', platform: 'win32', sandboxRoot: 'C:/ffw/sandboxes' },
    { id: 'm3', platform: 'darwin', sandboxRoot: '/ffw/sandboxes' },
    { id: 'desktop-coosego', platform: 'win32', playOnly: 'lothsahn: "desktop-coosego is installed in play only mode"' },
    { id: 'm5', platform: 'darwin', sandboxRoot: '/ffw/sandboxes' },
  ] as unknown as Machine[];
  const agents: Record<string, number> = { beast: 6, lothlaptop: 1, m3: 2, m5: 4 };
  const online = new Set(['beast', 'lothlaptop', 'm3', 'm5']);
  const tr = new TimedRuns({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'w1996tr-')),
    store: {} as AttachmentStore,
    machines: () => machines,
    isOnline: (id) => online.has(id),
    offers: () => true,
    post: () => true,
    deliver: async () => {},
    // index.ts: a small worker computer (at most 4 agent slots) that takes timed runs (never m5)
    smallWorker: (m) => (m.id !== 'm5' && agents[m.id] <= 4 ? { agents: agents[m.id] } : undefined),
  });
  const t = tr.targets();
  assert.deepEqual(t.map((x) => `${x.id}:${x.kind}`).sort(), ['desktop-coosego:play-only', 'lothlaptop:small', 'm3:small']);
  // desktop-coosego is offline: an online small one goes first; the Mac takes no Windows player
  assert.deepEqual(tr.windowsTargets().map((x) => x.id), ['lothlaptop', 'desktop-coosego']);
  online.add('desktop-coosego');
  assert.deepEqual(tr.windowsTargets().map((x) => x.id), ['desktop-coosego', 'lothlaptop'], 'a play-only turn idles nobody');
  assert.match(tr.capacityLine() ?? '', /^Timed-run computers \(w1946, w1996: .*\): desktop-coosego \(play-only, online; free\), lothlaptop \(small, 1 agent slot, online; free\)\.$/);
  // the fewest runs ahead, then the fewest agent slots
  const T = (id: string, kind: TimedTarget['kind'], runs: number, a: number): TimedTarget => ({ id, kind, online: true, offers: true, runs: Array.from({ length: runs }) as never, why: '', agents: a });
  assert.deepEqual(rankTargets([T('b', 'small', 1, 1), T('a', 'small', 0, 3), T('p', 'play-only', 2, 0)]).map((x) => x.id), ['p', 'a', 'b']);
});

test('w1996: on a big computer a timed leg with no via goes to a timed_run computer, built here; via leg keeps the hand-off', () => {
  const d = decideTimedPlace({ here: at('beast'), places: fleet(), timedRun: ['lothlaptop'] });
  assert.equal(d.verdict, 'elsewhere');
  assert.equal(d.timedRun, 'lothlaptop');
  assert.equal(d.choose, true);
  assert.match(d.why, /^beast has 6 agent slots \(6 live now\): an exclusive turn there idles all the others; a Windows player A\/B goes to lothlaptop by timed_run, built here/);
  // the worker said what it is: a player A/B, or something else timed
  assert.equal(decideTimedPlace({ here: at('lothdesktop'), places: fleet(), via: 'timed_run', timedRun: ['lothlaptop'] }).choose, undefined);
  const leg = decideTimedPlace({ here: at('beast'), places: fleet(), via: 'leg', timedRun: ['lothlaptop'] });
  assert.equal(leg.timedRun, undefined);
  assert.deepEqual(leg.needs, ['lothlaptop', 'm3', 'biscuit']);
  // a Mac player goes as a leg (timed_run plays Windows players); a small computer times its own; the asker is never its own target
  assert.equal(decideTimedPlace({ here: at('beast'), places: fleet(), platform: 'darwin', timedRun: ['lothlaptop'] }).timedRun, undefined);
  assert.equal(decideTimedPlace({ here: at('lothlaptop'), places: fleet(), timedRun: ['lothlaptop'] }).verdict, 'here');
  // a play-only computer up and no small one online: the A/B still leaves BEAST
  const lone = decideTimedPlace({ here: at('beast'), places: fleet().filter((c) => c.maxAgents > 4), timedRun: ['desktop-coosego'] });
  assert.equal(lone.timedRun, 'desktop-coosego');
  // same_machine and the release lane still keep it here
  assert.equal(decideTimedPlace({ here: at('beast'), places: fleet(), timedRun: ['lothlaptop'], sameMachine: 'the base ran here' }).verdict, 'here');
  assert.equal(decideTimedPlace({ here: at('beast'), places: fleet(), timedRun: ['lothlaptop'], exempt: 'release' }).verdict, 'here');
  // the guard then refuses a local exclusive ticket, naming timed_run and the way back to a leg
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const no = checkTimedAsk('bash scripts/bench/probe_ab_win.sh', { mark: { required: true, why: 'beast has 6 agent slots' }, verdict: { verdict: 'elsewhere', why: d.why, until, timedRun: 'lothlaptop' } });
  assert.match(no ?? '', /lothlaptop by timed_run: build the players here \(shared tickets\) and call timed_run \(for a leg that is no Windows player A\/B, call timed_place again with via "leg"\)/);
});

test('w1996: a borrowed player-slot pair is one no live lease holds; it is leased for the turn and marked so the sandbox refills it', (t) => {
  const d = tmp(t, 'w1996slots-');
  const root = path.join(d, 'players');
  const lease = (slot: string, pid: number, host = os.hostname().toLowerCase(), time = Date.now() / 1000) => {
    fs.mkdirSync(path.join(root, slot, 'leases'), { recursive: true });
    fs.writeFileSync(path.join(root, slot, 'leases', `${host}-${pid}-x.json`), JSON.stringify({ pid, host, time }));
  };
  const alive = (pid: number) => pid === 4242;
  lease('slot1-1', 4242); // slot1's client is playing
  lease('slot2-0', 999); // a dead pid: stale
  lease('slot3-0', 1, 'beast'); // a fresh lease from another host counts
  assert.equal(slotFree(path.join(root, 'slot1-1'), alive), false);
  assert.equal(slotFree(path.join(root, 'slot2-0'), alive), true);
  assert.equal(slotFree(path.join(root, 'slot3-0'), alive), false);
  assert.equal(slotFree(path.join(root, 'slot9-0'), alive), true, 'a slot never used is free');
  const p = borrowPair(root, ['slot1', 'slot3', 'slot2'], 2, { ownerPid: 4242, run: 'tr_0123456789', session: 'sess-1' }, alive)!;
  assert.equal(p.sandbox, 'slot2');
  assert.equal(p.leases.length, 2);
  const l = JSON.parse(fs.readFileSync(p.leases[0], 'utf8'));
  assert.equal(l.pid, 4242);
  assert.equal(l.session, 'sess-1');
  assert.equal(slotFree(path.join(root, 'slot2-0'), alive), false, 'leased for the turn');
  assert.equal(borrowPair(root, ['slot1', 'slot3'], 2, { ownerPid: 4242, run: 'r', session: 's' }, alive), undefined);
  assert.equal(borrowPair(root, ['slot1'], 1, { ownerPid: 4242, run: 'r', session: 's' }, alive)?.sandbox, 'slot1', 'one build needs only peer 0');

  // linkInto replaces the sandbox's own build and marks the slot with a fingerprint no build of player_slots.py has
  const src = path.join(d, 'build');
  fs.mkdirSync(path.join(src, 'finalfactory_Data'), { recursive: true });
  fs.writeFileSync(path.join(src, 'finalfactory.exe'), 'exe');
  fs.writeFileSync(path.join(src, 'finalfactory_Data', 'a.dll'), 'dll');
  const slot = path.join(root, 'slot2-0');
  fs.mkdirSync(path.join(slot, 'player'), { recursive: true });
  fs.writeFileSync(path.join(slot, 'player', 'old.txt'), 'the sandbox build');
  fs.writeFileSync(path.join(slot, 'slot.json'), JSON.stringify({ sha: 'abc', fingerprint: 'real', state: 'ready' }));
  const files = [{ path: 'finalfactory.exe' }, { path: 'finalfactory_Data/a.dll' }];
  assert.equal(linkInto(src, slot, files, 'key1', 'tr_0123456789'), 'linked');
  assert.equal(fs.existsSync(path.join(slot, 'player', 'old.txt')), false);
  assert.equal(fs.readFileSync(path.join(slot, 'player', 'finalfactory_Data', 'a.dll'), 'utf8'), 'dll');
  const m = JSON.parse(fs.readFileSync(path.join(slot, 'slot.json'), 'utf8'));
  assert.equal(m.fingerprint, 'timed-run:key1');
  assert.equal(m.state, 'ready');
  assert.equal(linkInto(src, slot, files, 'key1', 'tr_0123456789'), 'kept', 'the next turn of the run reuses it');
});

/** A queue ticket that is granted at once and can be revoked by the test. */
class FakeTicket implements RunTicket {
  static taken: { ownerPid: number; session: string; what: string }[] = [];
  static released = 0;
  private s: TicketState;
  constructor(o: { ownerPid: number; session: string; what: string }) {
    FakeTicket.taken.push(o);
    this.s = { kind: 'granted', ticket: `t${String(FakeTicket.taken.length).padStart(8, '0')}`, line: 'granted' };
  }
  async wait(): Promise<TicketState> {
    return this.s;
  }
  state() {
    return this.s;
  }
  release() {
    FakeTicket.released++;
  }
}

const FAKE_PLAYER = `
const fs = require('fs');
const a = process.argv.slice(2);
const log = a[a.indexOf('-logFile') + 1];
const exe = fs.readFileSync(require('path').join(process.cwd(), 'finalfactory.exe'), 'utf8');
const ms = exe.includes('fast') ? 15.5 : 16.5;
fs.writeFileSync(log, 'cwd: ' + process.cwd() + '\\n[Audit] PerfSummary hb=320 frames=1200 fps=60 ups=16 frameAvgMs=' + ms + ' frameP95Ms=18 frameMaxMs=30\\n');
`;

test('w1996: on a worker computer a timed run queues through the bench queue, plays in a borrowed sandbox pair, and gives the ticket back between turns', async (t) => {
  const d = tmp(t, 'w1996run-');
  const root = path.join(d, 'root');
  const fake = path.join(d, 'fake-player.cjs');
  fs.writeFileSync(fake, FAKE_PLAYER);
  // Two builds and a save, cut into pieces as the worker's daemon would, kept in a fake portal.
  const portal = new Map<string, string>();
  const mk = async (name: string, exe: string) => {
    const p = path.join(d, 'builds', name);
    fs.mkdirSync(path.join(p, 'finalfactory_Data'), { recursive: true });
    fs.writeFileSync(path.join(p, 'finalfactory.exe'), exe);
    fs.writeFileSync(path.join(p, 'finalfactory_Data', 'FFCore.dll'), `code ${name}`);
    const files = scanBuild(p);
    const pieces = await hashVariant(p, files);
    for (const pc of pieces) {
      const f = path.join(d, `piece-${pc.sha256}`);
      fs.writeFileSync(f, Buffer.concat(pc.parts.map((x) => fs.readFileSync(path.join(p, x.path)).subarray(x.offset, x.offset + x.length))));
      portal.set(`att_${pc.sha256.slice(0, 12)}`, f);
    }
    return { name, args: [], files, pieces };
  };
  const base = await mk('base', 'slow player');
  const fix = await mk('fix', 'fast player');
  const save = Buffer.from('PK save');
  const saveSha = createHash('sha256').update(save).digest('hex');
  fs.writeFileSync(path.join(d, 'save'), save);
  portal.set('att_save00000000', path.join(d, 'save'));
  const pieceIds: Record<string, string> = {};
  for (const v of [base, fix]) for (const pc of v.pieces) pieceIds[pc.sha256] = `att_${pc.sha256.slice(0, 12)}`;
  const order: TimedRunOrder = { id: 'tr_00112233aa', what: 'w1891 RoundRobin', requests: ['w1891'], session: 'sess-beast', variants: [base, fix], save: { id: 'att_save00000000', name: 'bench.zip', size: save.length, sha256: saveSha }, pieceIds, settings: { ...TIMED_DEFAULTS, rounds: 2, sampleS: 5, settleS: 5 } };
  // slot1's own client still plays: the run borrows slot2's pair
  const slots = path.join(root, 'players');
  fs.mkdirSync(path.join(slots, 'slot1-1', 'leases'), { recursive: true });
  fs.writeFileSync(path.join(slots, 'slot1-1', 'leases', `${os.hostname().toLowerCase()}-${process.pid}-x.json`), JSON.stringify({ pid: process.pid, host: os.hostname().toLowerCase(), time: Date.now() / 1000 }));
  const reports: TimedRunReport[] = [];
  let ownerEnded = 0;
  FakeTicket.taken = [];
  FakeTicket.released = 0;
  const done = new Promise<void>((resolve) => {
    const runner = new TimedRunner({
      root,
      portalUrl: 'http://127.0.0.1:1',
      token: 'x',
      send: (m) => {
        reports.push(m);
        if (m.type === 'timed_run_done') resolve();
      },
      log: () => {},
      personBusy: () => undefined,
      savesDir: path.join(d, 'saves'),
      pollMs: 5,
      fetchPiece: async (ref, dest) => void fs.copyFileSync(portal.get(ref.id)!, dest),
      spawnPlayer: (_exe, args, cwd) => spawn(process.execPath, [fake, ...args], { cwd, stdio: 'ignore' }),
      worker: {
        sandboxIds: () => ['slot1', 'slot2'],
        ticket: (o) => ({ ticket: new FakeTicket(o) }),
        owner: () => ({ pid: 4242, end: () => void ownerEnded++ }),
        // a turn plans 1 ms: every leg after a turn's first waits for the next turn
        turnPlanMs: 1,
      },
    });
    runner.enqueue(order);
  });
  await done;
  const end = reports.find((r) => r.type === 'timed_run_done') as Extract<TimedRunReport, { type: 'timed_run_done' }>;
  assert.equal(end.ok, true, JSON.stringify(reports.slice(-3)));
  assert.equal(end.legs.length, 4);
  assert.ok(end.legs.every((l) => l.ok));
  // four turns of one leg each, every ticket taken for the asking worker's session, owned by the run's own owner process
  assert.equal(FakeTicket.taken.length, 4);
  assert.ok(FakeTicket.taken.every((x) => x.session === 'sess-beast' && x.ownerPid === 4242 && x.what === 'timed run tr_00112233aa: w1891 RoundRobin'));
  assert.equal(FakeTicket.released, 4);
  assert.equal(ownerEnded, 1);
  assert.ok(reports.some((r) => r.type === 'timed_run_status' && /turn 1 gave its ticket back after 1 of 4 legs/.test(r.line)));
  // the legs ran from slot2's pair (slot1's client held its lease), which holds no lease of the run afterwards
  const legLog = fs.readFileSync(path.join(root, 'timing', 'runs', order.id, 'fix', 'round1', 'player.log'), 'utf8');
  assert.match(legLog, new RegExp(`cwd: ${path.join(slots, 'slot2-1', 'player').replace(/\\/g, '\\\\')}`));
  assert.deepEqual(fs.readdirSync(path.join(slots, 'slot2-0', 'leases')), []);
  assert.match(JSON.parse(fs.readFileSync(path.join(slots, 'slot2-0', 'slot.json'), 'utf8')).fingerprint, /^timed-run:/);
  assert.deepEqual(fs.readdirSync(path.join(d, 'saves')), [], 'the save copy is gone');
});
