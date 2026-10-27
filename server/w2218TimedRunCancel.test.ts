// w2218: no bench ticket outlives its timed run. lothsahn, 2026-10-26: "It looks like LothLaptops lock is in a bad state for
// an old worker run that's no longer scheduled" / "Please fix that, figure out how to happened, and fix so it can't happen
// again". A run's ticket goes back when its player dies, when the portal cancels it (before it starts, waiting for its ticket,
// mid-leg), and when a person starts playing mid-turn; the portal stops a run it no longer waits for (it gave up on it, or
// the daemon's hello or report names one it ended or never knew), whether or not the worker that sent it is still there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimedRuns } from './timedRuns.ts';
import { TimedRunner, type RunTicket } from '../machine/timedRunner.ts';
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

/** A queue ticket: granted at once, or (grant false) never granted. */
class Ticket implements RunTicket {
  static taken = 0;
  static released: string[] = [];
  private readonly s: TicketState;
  private readonly what: string;
  private readonly grant: boolean;
  constructor(what: string, grant: boolean) {
    this.what = what;
    this.grant = grant;
    Ticket.taken++;
    this.s = grant ? { kind: 'granted', ticket: `t${String(Ticket.taken).padStart(8, '0')}`, line: 'granted' } : ({ kind: 'waiting', line: 'behind t00000001' } as unknown as TicketState);
  }
  wait(): Promise<TicketState> {
    return this.grant ? Promise.resolve(this.s) : new Promise(() => {});
  }
  state() {
    return this.s;
  }
  release() {
    Ticket.released.push(this.what);
  }
}

const PLAYER_OK = `
const fs = require('fs');
const a = process.argv.slice(2);
fs.writeFileSync(a[a.indexOf('-logFile') + 1], '[Audit] PerfSummary hb=320 frames=1200 fps=60 ups=16 frameAvgMs=16.5 frameP95Ms=18 frameMaxMs=30\\n');
`;

/** A worker computer's runner and an order of `rounds` legs of one build; `player` plays each leg. */
async function rig(t: { after(fn: () => void): void }, o: { rounds?: number; grant?: boolean; player: (args: string[]) => ChildProcess; personBusy?: () => string | undefined }) {
  const d = tmp(t, 'w2218-');
  const pieces = new Map<string, string>();
  const order = async (id: string): Promise<TimedRunOrder> => {
    const p = path.join(d, 'builds', id);
    fs.mkdirSync(path.join(p, 'finalfactory_Data'), { recursive: true });
    fs.writeFileSync(path.join(p, 'finalfactory.exe'), `player ${id}`);
    const files = scanBuild(p);
    const ps = await hashVariant(p, files);
    const pieceIds: Record<string, string> = {};
    for (const pc of ps) {
      const f = path.join(d, `piece-${pc.sha256}`);
      fs.writeFileSync(f, Buffer.concat(pc.parts.map((x) => fs.readFileSync(path.join(p, x.path)).subarray(x.offset, x.offset + x.length))));
      pieceIds[pc.sha256] = `att_${pc.sha256.slice(0, 12)}`;
      pieces.set(pieceIds[pc.sha256], f);
    }
    const save = Buffer.from(`PK save ${id}`);
    fs.writeFileSync(path.join(d, `save-${id}`), save);
    pieces.set(`att_save_${id}`, path.join(d, `save-${id}`));
    return { id, what: `w2184 run ${id}`, requests: ['w2184'], session: 'sess-ba1849fa', variants: [{ name: 'base', args: [], files, pieces: ps }], save: { id: `att_save_${id}`, name: 'bench.zip', size: save.length, sha256: createHash('sha256').update(save).digest('hex') }, pieceIds, settings: { ...TIMED_DEFAULTS, rounds: o.rounds ?? 1, sampleS: 5, settleS: 5 } };
  };
  const reports: TimedRunReport[] = [];
  const owners = { ended: 0 };
  Ticket.taken = 0;
  Ticket.released = [];
  const runner = new TimedRunner({
    root: path.join(d, 'root'),
    portalUrl: 'http://127.0.0.1:1',
    token: 'x',
    send: (m) => void reports.push(m),
    log: () => {},
    personBusy: o.personBusy ?? (() => undefined),
    savesDir: path.join(d, 'saves'),
    pollMs: 5,
    fetchPiece: async (ref, dest) => void fs.copyFileSync(pieces.get(ref.id)!, dest),
    spawnPlayer: (_exe, args) => o.player(args),
    worker: {
      sandboxIds: () => ['slot1'],
      ticket: (x) => ({ ticket: new Ticket(x.what, o.grant ?? true) }),
      owner: () => ({ pid: 4242, end: () => void owners.ended++ }),
    },
  });
  const ended = (id: string) =>
    new Promise<Extract<TimedRunReport, { type: 'timed_run_done' }>>((resolve, reject) => {
      const until = Date.now() + 30_000;
      const look = () => {
        const r = reports.find((x) => x.type === 'timed_run_done' && x.id === id);
        if (r) resolve(r as Extract<TimedRunReport, { type: 'timed_run_done' }>);
        else if (Date.now() > until) reject(new Error(`${id} never ended: ${JSON.stringify(reports.slice(-3))}`));
        else setTimeout(look, 10);
      };
      look();
    });
  const until = (what: string, ok: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const end = Date.now() + 30_000;
      const look = () => (ok() ? resolve() : Date.now() > end ? reject(new Error(`never: ${what}`)) : setTimeout(look, 10));
      look();
    });
  return { d, runner, order, reports, owners, ended, until };
}

const node = (code: string, args: string[] = []) => spawn(process.execPath, ['-e', code, '--', ...args], { stdio: 'ignore' });

test('w2218: a run whose player dies ends, and its ticket, owner and save copy go back', async (t) => {
  const r = await rig(t, { player: () => node('process.exit(3)') });
  const o = await r.order('tr_00000000a1');
  r.runner.enqueue(o);
  const end = await r.ended(o.id);
  assert.equal(end.ok, false);
  assert.match(end.legs[0].note ?? '', /no PerfSummary in player\.log \(exit 3\)/);
  assert.deepEqual(Ticket.released, [`timed run ${o.id}: ${o.what}`]);
  assert.equal(r.owners.ended, 1);
  assert.deepEqual(fs.readdirSync(path.join(r.d, 'saves')), []);

});

test('w2218: a run cancelled before it started never takes a ticket; one cancelled while it waits for its ticket gives it back', async (t) => {
  const r = await rig(t, { grant: false, player: () => node('') });
  const first = await r.order('tr_00000000b1');
  const second = await r.order('tr_00000000b2');
  r.runner.enqueue(first);
  r.runner.enqueue(second);
  await r.until('the first run queued for its ticket', () => Ticket.taken === 1);
  assert.deepEqual(r.runner.active(), [first.id, second.id]);
  // never started: dropped from the queue, no ticket
  assert.equal(r.runner.cancel(second.id, 'the portal gave up on it'), true);
  assert.match((await r.ended(second.id)).error ?? '', /^cancelled: the portal gave up on it/);
  assert.deepEqual(r.runner.active(), [first.id]);
  // waiting for a ticket the queue never grants: the wait ends, the ticket and its owner go back
  assert.equal(r.runner.cancel(first.id, 'the portal has no such run'), true);
  assert.match((await r.ended(first.id)).error ?? '', /^cancelled: the portal has no such run/);
  assert.deepEqual(Ticket.released, [`timed run ${first.id}: ${first.what}`]);
  assert.equal(Ticket.taken, 1);
  assert.equal(r.owners.ended, 1);
  assert.deepEqual(r.runner.active(), []);
  assert.equal(r.runner.cancel('tr_00000000ff', 'x'), false);
});

test('w2218: a run cancelled mid-leg ends its player and gives its ticket back', async (t) => {
  let child: ChildProcess | undefined;
  const r = await rig(t, { player: () => (child = node('setTimeout(() => {}, 120000)')) });
  const o = await r.order('tr_00000000c1');
  r.runner.enqueue(o);
  await r.until('the leg started', () => !!child?.pid);
  r.runner.cancel(o.id, 'the portal moved it to m3');
  const end = await r.ended(o.id);
  assert.equal(end.ok, false);
  assert.match(end.error ?? '', /^cancelled: the portal moved it to m3/);
  await r.until('the player ended', () => child!.exitCode !== null || child!.signalCode !== null);
  assert.deepEqual(Ticket.released, [`timed run ${o.id}: ${o.what}`]);
  assert.equal(r.owners.ended, 1);
  assert.deepEqual(fs.readdirSync(path.join(r.d, 'saves')), []);
});

test('w2218: a person who starts playing mid-turn ends the turn: the ticket goes back while they play, the run goes on after', async (t) => {
  let plays = false;
  let legs = 0;
  let releasedWhilePlaying = false;
  const r = await rig(t, {
    rounds: 2,
    personBusy: () => (plays ? 'Lothsahn plays Final Factory here' : undefined),
    player: (args) => {
      legs++;
      const c = node(PLAYER_OK, args);
      // the person sits down during the first leg
      if (legs === 1) plays = true;
      return c;
    },
  });
  const o = await r.order('tr_00000000d1');
  r.runner.enqueue(o);
  await r.until('the turn gave its ticket back', () => Ticket.released.length === 1);
  releasedWhilePlaying = plays && legs === 1;
  plays = false;
  const end = await r.ended(o.id);
  assert.ok(releasedWhilePlaying, 'the ticket went back while the person played, before the second leg');
  assert.equal(end.ok, true, JSON.stringify(r.reports.slice(-3)));
  assert.equal(end.legs.length, 2);
  assert.equal(Ticket.taken, 2);
  assert.equal(Ticket.released.length, 2);
  assert.ok(r.reports.some((x) => x.type === 'timed_run_status' && /a person plays here, so its ticket goes back/.test(x.line)));
});

test('w2218: the portal stops a run it no longer waits for: given up on while its worker is stopped, ended, or never known', (t) => {
  const d = tmp(t, 'w2218portal-');
  const old = new Date(Date.now() - 4 * 3600_000).toISOString();
  const order = { id: 'tr_f0fd13d330', what: 'w2184', requests: ['w2184'], session: 'sess-ba1849fa', variants: [], save: { id: 'att_s', name: 'bench.zip', size: 1, sha256: '0'.repeat(64) }, pieceIds: {}, settings: { ...TIMED_DEFAULTS } } as unknown as TimedRunOrder;
  const run = (id: string, state: string, updatedAt: string) => ({ id, session: 'sess-ba1849fa', requests: ['w2184'], what: 'w2184', from: 'beast', machine: 'lothlaptop', state, line: 'turn 1: holds t00000151', createdAt: old, updatedAt, order: { ...order, id } });
  fs.mkdirSync(path.join(d, 'portal'));
  fs.writeFileSync(path.join(d, 'portal', 'timed-runs.json'), JSON.stringify({ runs: [run('tr_f0fd13d330', 'running', old), run('tr_00000000e1', 'running', new Date().toISOString())], pieces: {} }));
  const posted: { id: string; msg: { type: string; id: string; why: string } }[] = [];
  const told: string[] = [];
  let online = true;
  const tr = new TimedRuns({
    dataDir: path.join(d, 'portal'),
    store: { forget: () => {}, get: () => undefined, grant: () => {} } as unknown as AttachmentStore,
    machines: () => [{ id: 'lothlaptop', platform: 'win32' } as unknown as Machine],
    isOnline: () => online,
    offers: () => true,
    post: (id, msg) => (posted.push({ id, msg: msg as never }), true),
    // the worker that sent it is stopped: the message to it fails
    deliver: async (session) => {
      told.push(session);
      throw new Error('worker ba1849fa is stopped');
    },
    log: () => {},
  });
  const cancels = () => posted.filter((p) => p.msg.type === 'timed_run_cancel').map((p) => `${p.id} ${p.msg.id}: ${p.msg.why}`);
  // nothing heard past its bound: failed, and its daemon told to stop it and give its ticket back
  tr.tick();
  assert.equal(tr.get('tr_f0fd13d330')?.state, 'failed');
  assert.equal(tr.get('tr_00000000e1')?.state, 'running', 'a run still heard from is left alone');
  assert.deepEqual(told, ['sess-ba1849fa']);
  assert.equal(cancels().length, 1);
  assert.match(cancels()[0], /^lothlaptop tr_f0fd13d330: the portal gave up on it: nothing heard from lothlaptop/);
  // still reporting progress after that: stopped again
  tr.onReport('lothlaptop', { type: 'timed_run_status', id: 'tr_f0fd13d330', state: 'waiting', line: 'paused before base round 2' });
  assert.match(cancels()[1], /^lothlaptop tr_f0fd13d330: the portal already ended it \(failed: nothing heard/);
  // offline when it gave up: told on its hello, which also names a run the portal never knew; a live run stays
  online = false;
  tr.onReport('lothlaptop', { type: 'timed_run_status', id: 'tr_f0fd13d330', state: 'waiting', line: 'x' });
  assert.equal(cancels().length, 2);
  online = true;
  tr.onHello('lothlaptop', ['tr_f0fd13d330', 'tr_00000000e1', 'tr_0000000077']);
  assert.match(cancels()[2], /^lothlaptop tr_f0fd13d330: the portal already ended it/);
  assert.equal(cancels()[3], 'lothlaptop tr_0000000077: the portal has no such run');
  assert.equal(cancels().length, 4, 'tr_00000000e1 is still waited for there: no cancel');
});
