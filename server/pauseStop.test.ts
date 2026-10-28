import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PAUSE_DAEMON_KILL_MS, PAUSE_RESWEEP_MS, PauseStop, type PauseStopDeps } from '../machine/pauseStop.ts';
import { PAUSE_DAEMON_KILL_MS as PORTAL_KILL_MS, PAUSE_GRACE_MS, PAUSE_STOP_AFTER_MS } from './machinePause.ts';
import { LeftoverReaper, type LeftoverDeps, type ProcEnv } from '../machine/leftovers.ts';
import { realHostProcs } from '../machine/hostWatch.ts';
import type { Proc } from '../machine/unity.ts';

// w2443 (lothsahn, 2026-10-27): "Pausing a machine should stop existing runs on that machine. They should terminate in a minute
// or two." and "The worker harness should be authoritative and if the worker is nonresponsive, should kill the worker after a
// few minutes. There's no way it should keep running". The daemon's own end of it (machine/pauseStop.ts): timed runs at once;
// at 90 s every worker's process tree, every sandbox editor and every process FF Factory started; never a person's own.

function daemon(o: { timed?: string[]; sessions?: string[]; editors?: string[] } = {}) {
  const st = {
    now: 1_000_000,
    timed: [...(o.timed ?? [])],
    sessions: new Set(o.sessions ?? []),
    editors: new Set(o.editors ?? []),
    cancelled: [] as string[],
    ended: [] as string[],
    closed: [] as string[],
    leftoverLooks: 0,
    timers: [] as { at: number; fn: () => void; off: boolean }[],
    logs: [] as string[],
    events: [] as string[],
  };
  const d: PauseStopDeps = {
    machineId: 'lothdesktop',
    timedRuns: () => [...st.timed],
    cancelTimed: (id, why) => {
      st.cancelled.push(`${id}: ${why}`);
      st.timed = st.timed.filter((x) => x !== id);
    },
    liveSessions: () => [...st.sessions],
    endSession: async (id) => {
      st.ended.push(id);
      st.sessions.delete(id);
    },
    editors: () => [...st.editors],
    closeEditor: async (id) => {
      st.closed.push(id);
      st.editors.delete(id);
      return 'stopped';
    },
    endLeftovers: async () => {
      st.leftoverLooks++;
      return [];
    },
    now: () => st.now,
    setTimer: (fn, ms) => {
      const t = { at: st.now + ms, fn, off: false };
      st.timers.push(t);
      return { cancel: () => void (t.off = true) };
    },
    log: (l) => void st.logs.push(l),
    event: (t) => void st.events.push(t),
  };
  const ps = new PauseStop(d);
  /** Move the clock on, firing due timers (and waiting for what they start). */
  const advance = async (ms: number) => {
    const end = st.now + ms;
    for (;;) {
      const due = st.timers.filter((t) => !t.off && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      st.now = due.at;
      due.off = true;
      due.fn();
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    }
    st.now = end;
  };
  return { st, ps, advance };
}

test('w2443: the deadlines: the portal interrupts at 60 s and stops at 75 s, the daemon ends what is left at 90 s, all within two minutes', () => {
  assert.equal(PAUSE_DAEMON_KILL_MS, PORTAL_KILL_MS, 'the portal and the daemon agree on the deadline');
  assert.ok(PAUSE_GRACE_MS.value + PAUSE_STOP_AFTER_MS.value < PAUSE_DAEMON_KILL_MS);
  // An editor's stop takes up to 30 s more (SIGTERM, then forced): still inside lothsahn's "a minute or two".
  assert.ok(PAUSE_DAEMON_KILL_MS + 30_000 <= 120_000);
});

test('w2443: a timed run is cancelled the moment the machine is paused, with why; one that arrives while paused is refused', async () => {
  const t = daemon({ timed: ['tr_1', 'tr_2'] });
  assert.equal(t.ps.refuseTimed(), undefined);
  t.ps.update(true, 'paused by hand from the tray');
  assert.deepEqual(t.st.cancelled.map((c) => c.split(':')[0]), ['tr_1', 'tr_2']);
  assert.match(t.st.cancelled[0], /lothdesktop was paused from its tray app \(paused by hand from the tray\) \(w2443\)/);
  assert.match(t.ps.refuseTimed()!, /^cancelled: lothdesktop was paused/);
  t.ps.update(true, 'paused by hand from the tray');
  assert.equal(t.st.cancelled.length, 2, 'a second report of the same pause does nothing');
  t.ps.update(false, 'running');
  assert.equal(t.ps.refuseTimed(), undefined);
});

test('w2443: a nonresponsive worker, its editor and its leftovers are ended by the daemon at 90 s, and again while paused; nothing after the unpause', async () => {
  const t = daemon({ sessions: ['ab12cd34'], editors: ['slot2'] });
  t.ps.update(true, 'someone is using this PC');
  await t.advance(PAUSE_DAEMON_KILL_MS - 1000);
  assert.deepEqual([t.st.ended, t.st.closed, t.st.leftoverLooks], [[], [], 0], 'the worker has until 90 s to push and stop by itself');
  assert.equal(t.ps.endsNow(), undefined, 'the leftover reaper keeps its graces until the deadline');
  await t.advance(1000);
  assert.deepEqual(t.st.ended, ['ab12cd34'], 'the worker that ignored the notice, the interrupt and the stop is ended with its process tree');
  assert.deepEqual(t.st.closed, ['slot2']);
  assert.equal(t.st.leftoverLooks, 2, 'two looks: the reaper ends a process once two looks have seen it');
  assert.match(t.ps.endsNow()!, /lothdesktop was paused/);
  assert.match(t.st.events[0], /worker ab12cd34 ended with its process tree; editor of slot2 closed/);
  // Something started meanwhile (a new editor) goes at the next sweep.
  t.st.editors.add('slot3');
  await t.advance(PAUSE_RESWEEP_MS);
  assert.deepEqual(t.st.closed, ['slot2', 'slot3']);
  t.ps.update(false, 'running');
  t.st.sessions.add('ef56ab78');
  await t.advance(10 * PAUSE_DAEMON_KILL_MS);
  assert.deepEqual(t.st.ended, ['ab12cd34'], 'unpaused: nothing more is ended');
  assert.equal(t.ps.endsNow(), undefined);
});

test('w2443: unpaused before the deadline: nothing is ended', async () => {
  const t = daemon({ sessions: ['ab12cd34'], editors: ['slot2'] });
  t.ps.update(true, 'outside its work schedule');
  await t.advance(30_000);
  t.ps.update(false, 'running');
  await t.advance(5 * PAUSE_DAEMON_KILL_MS);
  assert.deepEqual([t.st.ended, t.st.closed, t.st.leftoverLooks], [[], [], 0]);
});

// ---------------------------------------------------------------- the leftover reaper on a paused machine

const ROOT = '/home/u/ffw';
const PLAYERS = `${ROOT}/players`;
const TMP = `${ROOT}/tmp`;
const env = (session: string, sandbox = 'slot1'): ProcEnv => ({ session, sandbox, machine: 'biscuit' });

function reaper(procs: Proc[], envs: Map<number, ProcEnv>, o: { live: string[]; paused: () => string | undefined; personPlay?: boolean }) {
  const st = { procs: [...procs], signals: [] as string[], now: 1_000_000_000 };
  const deps: LeftoverDeps = {
    platform: 'linux',
    machineId: 'biscuit',
    procs: async () => st.procs,
    envOf: async (pids) => new Map([...envs].filter(([pid]) => pids.includes(pid))),
    inspect: async (pids) => st.procs.filter((p) => pids.includes(p.pid)).map((p) => ({ pid: p.pid, startedAt: st.now - 3_600_000, cpuMs: 0 })),
    sessionLive: (id) => o.live.includes(id),
    sessionKnown: () => true,
    resumable: () => true,
    wakeAt: () => undefined,
    liveSandboxes: () => new Set(['slot1']),
    ready: () => true,
    slotRoots: () => [PLAYERS],
    tempRoot: () => TMP,
    leases: () => [],
    protectedPaths: () => [`${ROOT}/repo`, `${ROOT}/daemon`],
    places: () => [{ id: 'slot1', path: `${ROOT}/sandboxes/slot1` }],
    self: () => [100, 9212],
    host: 'biscuit',
    kill: (pid, sig) => {
      st.signals.push(`${sig} ${pid}`);
      st.procs = st.procs.filter((x) => x.pid !== pid);
    },
    exists: () => false,
    remove: () => undefined,
    sleep: async () => undefined,
    now: () => st.now,
    log: () => undefined,
    onEvent: () => undefined,
    personPlay: () => !!o.personPlay,
    pauseEnds: o.paused,
  };
  return { st, r: new LeftoverReaper(deps), alive: (pid: number) => st.procs.some((p) => p.pid === pid) };
}

test('w2443: on a paused machine past its deadline, a live worker\'s player, display, batch build and shell end at once; a person\'s game and an editor never', async () => {
  const SYSTEMD = { pid: 9212, ppid: 1, cmd: '/usr/lib/systemd/systemd --user' };
  const procs: Proc[] = [
    SYSTEMD,
    { pid: 90, ppid: 9212, cmd: `${PLAYERS}/slot1-0/player/finalfactory.x86_64 -batchmode -ffAutomation` },
    { pid: 91, ppid: 9212, cmd: `${TMP}/ffa-ab12cd34/xv/root/usr/bin/Xvfb :99 -screen 0 1280x720x24` },
    { pid: 92, ppid: 9212, cmd: '/opt/Unity/Editor/Unity -batchmode -quit -projectPath /home/u/ffw/sandboxes/slot1 -executeMethod Build.Player' },
    { pid: 93, ppid: 9212, cmd: '/usr/bin/bash -c ./run_tour.sh' },
    // A person's own game from Steam (no worker's environment), and the sandbox's interactive editor (closed by its own stop).
    { pid: 4242, ppid: 9000, cmd: '/home/u/.steam/steam/steamapps/common/Final Factory/FinalFactory.x86_64 -screen-fullscreen 1' },
    { pid: 70, ppid: 9212, cmd: '/opt/Unity/Editor/Unity -projectPath /home/u/ffw/sandboxes/slot1' },
  ];
  const envs = new Map<number, ProcEnv>([90, 91, 92, 93].map((pid) => [pid, env('ab12cd34')]));
  let deadline = false;
  const m = reaper(procs, envs, { live: ['ab12cd34'], paused: () => (deadline ? 'biscuit was paused from its tray app' : undefined), personPlay: true });
  await m.r.look();
  await m.r.look();
  assert.deepEqual(m.st.signals, [], 'before the deadline a live worker\'s processes are its own');
  deadline = true;
  await m.r.look();
  await m.r.look();
  for (const pid of [90, 91, 92, 93]) assert.ok(!m.alive(pid), `pid ${pid} (the worker's) ended`);
  assert.ok(m.alive(4242), "a person's own game is never ended");
  assert.ok(m.alive(70), 'an interactive editor is not the reaper\'s: the pause closes it with its save-first stop');
});

// ---------------------------------------------------------------- the real thing: a worker that ignores the stop

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('w2443, on this machine: a worker that ignores SIGTERM and its stop is ended at the deadline with its whole tree (its child and grandchild)', async () => {
  // A "worker": a node process that ignores SIGTERM and starts a child that starts a grandchild (its shell and a player).
  const grand = `setInterval(() => {}, 1000)`;
  const child = `const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:'ignore'}); process.stdout.write(String(g.pid)+'\\n'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  const root = `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','ignore']}); c.stdout.on('data',(d)=>process.stdout.write(c.pid+' '+d)); setInterval(()=>{},1000);`;
  const w = spawn(process.execPath, ['-e', root], { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  const line = await new Promise<string>((res, rej) => {
    let buf = '';
    w.stdout!.on('data', (d) => {
      buf += String(d);
      if (buf.includes('\n')) res(buf.trim());
    });
    setTimeout(() => rej(new Error(`no tree in 15 s: ${buf}`)), 15_000).unref();
  });
  const [childPid, grandPid] = line.split(/\s+/).map(Number);
  const pids = [w.pid!, childPid, grandPid];
  assert.ok(pids.every((p) => p > 0 && alive(p)), `the tree runs: ${pids.join(', ')}`);
  try {
    // It ignores the polite stop.
    if (process.platform !== 'win32') process.kill(w.pid!, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alive(w.pid!), 'the worker ignored SIGTERM');
    // The pause's deadline: the daemon ends it the way it ends an agent host (HostedSession.endNow -> endHostTree -> killTree).
    const t = daemon({ sessions: ['w'] });
    const procs = realHostProcs();
    t.ps = new PauseStop({ ...((t.ps as unknown as { d: PauseStopDeps }).d), endSession: () => procs.killTree(w.pid!) });
    t.ps.update(true, 'paused by hand');
    await t.ps.sweep();
    const until = Date.now() + 15_000;
    while (pids.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(pids.filter(alive), [], 'the worker, its child and its grandchild are all gone');
  } finally {
    for (const p of pids.filter(alive)) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
});
