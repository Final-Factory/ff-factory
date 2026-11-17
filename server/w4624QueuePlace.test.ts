// w4624: a timed run keeps its bench-queue place across a daemon restart. ben, 2026-11-17: timed run tr_97b11ed6a4 on
// lothdesktop "went back to the end of the queue at every daemon restart" (t00007465 -> t00007637 -> t00007672, each
// portal deploy) and played no leg in 4+ hours. The daemon now keeps the place in timing/runs/<run>/queue-place.json and
// takes the ticket again with bench_queue.py hold --place (the game repo's Documentation/Bench-Lock.md, w4624).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearQueuePlace, placeOf, QUEUE_PLACE_FILE, readQueuePlace, TimedRunner, writeQueuePlace, type RunTicket } from '../machine/timedRunner.ts';
import { BenchTicket, placeScript, supportsPlace, type TicketState } from '../machine/benchQueue.ts';
import { hashVariant, scanBuild } from '../machine/timedRunPack.ts';
import { TIMED_DEFAULTS, type TimedRunOrder, type TimedRunReport } from '../shared/timedRun.ts';

const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'w4624-queue-before-restart.json'), 'utf8')) as {
  run: string;
  status: string;
  place: { place: number; ticket: string; at: string };
};

const tmp = (t: { after(fn: () => void): void }, tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('w4624: the place a waiting ticket stands at is read from its helper\'s line and kept beside the run', (t) => {
  const dir = tmp(t, 'w4624place-');
  const line = FIXTURE.status.replace(/^waiting /, '');
  assert.deepEqual(placeOf(line), { place: 7465, ticket: 't00007465' }, 'its own number');
  assert.deepEqual(placeOf('t00007637: exclusive ticket, place 2, waiting for t00007447', 7465), { place: 7465, ticket: 't00007637' }, 'a ticket that kept an earlier place keeps keeping it');
  assert.equal(placeOf('taking a ticket'), undefined);
  const at = Date.parse(FIXTURE.place.at);
  writeQueuePlace(dir, FIXTURE.place);
  assert.deepEqual(readQueuePlace(dir, at + 3600_000), FIXTURE.place);
  assert.equal(readQueuePlace(dir, at + 25 * 3600_000), undefined, 'a day old: the run starts afresh');
  fs.writeFileSync(path.join(dir, QUEUE_PLACE_FILE), '{"place":"7465","ticket":"t1","at":"x"}');
  assert.equal(readQueuePlace(dir, at), undefined, 'malformed');
  clearQueuePlace(dir);
  assert.equal(fs.existsSync(path.join(dir, QUEUE_PLACE_FILE)), false);
  clearQueuePlace(dir);
});

/** The run's ticket before the restart: it waits with the fixture's line and is never granted (its daemon dies). */
class WaitingTicket implements RunTicket {
  readonly keptPlace = undefined;
  heard = false;
  async wait(_ms?: number, onLine?: (line: string) => void): Promise<TicketState> {
    onLine?.(FIXTURE.status.replace(/^waiting /, ''));
    this.heard = true;
    return new Promise<TicketState>(() => {});
  }
  state(): TicketState {
    return { kind: 'waiting', line: FIXTURE.status };
  }
  release() {}
}

/** The restarted daemon's tickets: each records the place it was asked to keep, says its line, then is granted. */
class AfterTicket implements RunTicket {
  static taken: (number | undefined)[] = [];
  readonly keptPlace?: number;
  private readonly name: string;
  constructor(place?: number) {
    AfterTicket.taken.push(place);
    this.keptPlace = place;
    this.name = `t0000${7636 + AfterTicket.taken.length}`;
  }
  async wait(_ms?: number, onLine?: (line: string) => void): Promise<TicketState> {
    onLine?.(`${this.name}: exclusive ticket, place 2, waiting for t00007447 exclusive probe multisel round 1`);
    return this.state();
  }
  state(): TicketState {
    return { kind: 'granted', ticket: this.name, line: 'granted' };
  }
  release() {}
}

const FAKE_PLAYER = `
const fs = require('fs');
const a = process.argv.slice(2);
const log = a[a.indexOf('-logFile') + 1];
fs.writeFileSync(log, 'cwd: ' + process.cwd() + '\\n[Audit] PerfSummary hb=320 frames=1200 fps=60 ups=16 frameAvgMs=16 frameP95Ms=18 frameMaxMs=30\\n');
`;

test('w4624: a timed run waiting when its daemon restarts takes its ticket again at the place it held, and only for that turn', async (t) => {
  const d = tmp(t, 'w4624run-');
  const root = path.join(d, 'root');
  const fake = path.join(d, 'fake-player.cjs');
  fs.writeFileSync(fake, FAKE_PLAYER);
  const portal = new Map<string, string>();
  const mk = async (name: string) => {
    const p = path.join(d, 'builds', name);
    fs.mkdirSync(path.join(p, 'finalfactory_Data'), { recursive: true });
    fs.writeFileSync(path.join(p, 'finalfactory.exe'), `player ${name}`);
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
  const variants = [await mk('pre3709_16ups'), await mk('post_20ups')];
  const save = Buffer.from('PK save');
  fs.writeFileSync(path.join(d, 'save'), save);
  portal.set('att_save00000000', path.join(d, 'save'));
  const pieceIds: Record<string, string> = {};
  for (const v of variants) for (const pc of v.pieces) pieceIds[pc.sha256] = `att_${pc.sha256.slice(0, 12)}`;
  const order: TimedRunOrder = { id: FIXTURE.run, what: 'w4587 Timed leg for w4554', requests: ['w4587'], session: 'sess-w4587', variants, save: { id: 'att_save00000000', name: 'bench.zip', size: save.length, sha256: createHash('sha256').update(save).digest('hex') }, pieceIds, settings: { ...TIMED_DEFAULTS, rounds: 1, sampleS: 5, settleS: 5 } };
  const runDir = path.join(root, 'timing', 'runs', order.id);
  const deps = (send: (m: TimedRunReport) => void, ticket: (o: { place?: number }) => RunTicket) => ({
    root,
    portalUrl: 'http://127.0.0.1:1',
    token: 'x',
    send,
    log: () => {},
    personBusy: () => undefined,
    savesDir: path.join(d, 'saves'),
    pollMs: 5,
    fetchPiece: async (ref: { id: string }, dest: string) => void fs.copyFileSync(portal.get(ref.id)!, dest),
    spawnPlayer: (_exe: string, args: string[], cwd: string) => spawn(process.execPath, [fake, ...args], { cwd, stdio: 'ignore' }),
    worker: { sandboxIds: () => ['slot1'], ticket: (o: { place?: number }) => ({ ticket: ticket(o) }), owner: () => ({ pid: 4242, end: () => {} }), turnPlanMs: 1 },
  });

  // Before the restart: the run's first ticket waits behind others; the daemon keeps its place.
  const before = new WaitingTicket();
  const asked: (number | undefined)[] = [];
  const old = new TimedRunner(deps(() => {}, (o) => (asked.push(o.place), before)));
  old.enqueue(order);
  const until = Date.now() + 20_000;
  while (!(before.heard && fs.existsSync(path.join(runDir, QUEUE_PLACE_FILE))) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(asked, [undefined], 'a first ticket has no earlier place');
  const kept = readQueuePlace(runDir)!;
  assert.deepEqual({ place: kept.place, ticket: kept.ticket }, { place: FIXTURE.place.place, ticket: FIXTURE.place.ticket });

  // The daemon restarts (the old runner is never let go: a dead daemon runs no finally) and the portal sends the run again.
  AfterTicket.taken = [];
  const reports: TimedRunReport[] = [];
  await new Promise<void>((resolve) => {
    const again = new TimedRunner(
      deps(
        (m) => {
          reports.push(m);
          if (m.type === 'timed_run_done') resolve();
        },
        (o) => new AfterTicket(o.place),
      ),
    );
    again.enqueue(order);
  });
  const end = reports.find((r) => r.type === 'timed_run_done') as Extract<TimedRunReport, { type: 'timed_run_done' }>;
  assert.equal(end.ok, true, JSON.stringify(reports.slice(-3)));
  assert.deepEqual(AfterTicket.taken, [7465, undefined], 'turn 1 keeps t00007465\'s place; turn 2, after a granted turn, queues at the back as before (w1832)');
  assert.ok(reports.some((r) => r.type === 'timed_run_status' && /turn 1: queued for this computer's exclusive bench ticket \(2 legs left\), at the place its ticket t00007465 held before this daemon restarted \(w4624\)/.test(r.line)));
  assert.equal(fs.existsSync(path.join(runDir, QUEUE_PLACE_FILE)), false, 'a granted ticket and a finished run leave no place behind');
  old.cancel(order.id, 'test over');
});

test('w4624: BenchTicket passes --place to an exclusive ticket\'s helper, and only a copy that knows the flag gets it', async (t) => {
  const dir = tmp(t, 'w4624args-');
  const script = path.join(dir, 'fake.cjs');
  fs.writeFileSync(script, "const fs=require('fs');const a=process.argv.slice(2);fs.writeFileSync(a[a.indexOf('--status')+1],'waiting '+JSON.stringify(a)+'\\n');setTimeout(()=>{},3000);");
  const argsOf = async (o: { mode: 'exclusive' | 'shared'; place?: number }) => {
    const k = new BenchTicket({ script, lock: path.join(dir, 'bench.lock'), what: 'timed run tr_x', python: process.execPath, tempDir: dir, ...o }).take();
    const deadline = Date.now() + 10_000;
    while (k.state().line === 'taking a ticket' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    k.release();
    return { args: JSON.parse(k.state().line) as string[], kept: k.keptPlace };
  };
  const ex = await argsOf({ mode: 'exclusive', place: 7465 });
  assert.deepEqual(ex.args.slice(ex.args.indexOf('--place'), ex.args.indexOf('--place') + 2), ['--place', '7465']);
  assert.equal(ex.kept, 7465);
  const sh = await argsOf({ mode: 'shared', place: 7465 });
  assert.equal(sh.args.includes('--place'), false, 'a shared ticket keeps no place');
  assert.equal((await argsOf({ mode: 'exclusive' })).args.includes('--place'), false);

  // Which copy: the chosen one when it takes --place, else a sandbox's of the same rules or newer that does, else none.
  const root = path.join(dir, 'root');
  const copy = (sb: string, v: number, place: boolean) => {
    const p = path.join(root, 'sandboxes', sb, 'scripts', 'bench', 'bench_queue.py');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `RULES_VERSION = ${v}\n${place ? 'h.add_argument("--place", type=float)\n' : ''}`);
    return p;
  };
  const old = copy('slot1', 5, false);
  assert.equal(supportsPlace(old), false);
  assert.equal(placeScript(old, [], root), undefined, 'no copy here takes it yet');
  copy('slot2', 4, true);
  assert.equal(placeScript(old, [], root), undefined, 'a copy with older rules is not used for it');
  const fresh = copy('slot3', 5, true);
  assert.equal(placeScript(old, [], root), fresh);
  assert.equal(placeScript(fresh, [], root), fresh);
});
