import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MacUnity, MacUnityWatch, editorsFor, projectPathOf, treeOf, type Proc, type UnityDeps } from '../machine/unity.ts';

const REPO = '/Users/u/games/MyGame';
const BIN = '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/MacOS/Unity';

/** A fake Mac: a process table, signals that do what the test says, a clock. */
function fakeMac(opts: { ignoresTerm?: boolean } = {}) {
  const world = { now: Date.parse('2026-09-24T16:00:00Z'), procs: [] as Proc[], files: new Set<string>(), killed: [] as string[], launched: 0 };
  const editor = (pid: number, repo = REPO) => {
    world.procs.push({ pid, ppid: 1, cmd: `${BIN} -projectpath ${repo} -useHub -hubIPC` });
    world.procs.push({ pid: pid + 1, ppid: pid, cmd: '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/Tools/UnityShaderCompiler' });
  };
  const deps: UnityDeps = {
    procs: async () => [...world.procs],
    kill: (pid, sig) => {
      world.killed.push(`${sig} ${pid}`);
      if (sig === 'SIGKILL' || !opts.ignoresTerm) world.procs = world.procs.filter((p) => p.pid !== pid && p.ppid !== pid);
    },
    launch: (bin, args) => {
      world.launched++;
      const pid = 5000 + world.launched * 10;
      world.procs.push({ pid, ppid: 1, cmd: `${bin} ${args.join(' ')}` });
      return pid;
    },
    exists: (p) => world.files.has(p),
    remove: (p) => void world.files.delete(p),
    sleep: async (ms) => void (world.now += ms),
    now: () => world.now,
  };
  return { world, editor, u: new MacUnity(REPO, deps, () => BIN) };
}

test('mac unity: finds only this clone\'s editor and what it started', () => {
  const procs: Proc[] = [
    { pid: 10, ppid: 1, cmd: `${BIN} -projectpath ${REPO} -useHub` },
    { pid: 11, ppid: 10, cmd: 'UnityShaderCompiler' },
    { pid: 12, ppid: 11, cmd: 'bee_backend' },
    { pid: 20, ppid: 1, cmd: `${BIN} -projectPath "${REPO}-other"` },
    { pid: 30, ppid: 1, cmd: '/Applications/Unity Hub.app/Contents/MacOS/Unity Hub' },
  ];
  assert.equal(projectPathOf(procs[0].cmd), REPO);
  assert.deepEqual(editorsFor(procs, REPO).map((p) => p.pid), [10]);
  assert.deepEqual(editorsFor(procs, `${REPO}/`).map((p) => p.pid), [10]);
  assert.deepEqual(treeOf(procs, 10), [10, 11, 12]);
});

test('mac unity: stop is graceful, then forced; force kills at once; the stale lock goes; restart relaunches', async () => {
  const { world, editor, u } = fakeMac({ ignoresTerm: true });
  editor(100);
  world.files.add(`${REPO}/Temp/UnityLockfile`);
  const out = await u.stop({ graceMs: 5000 });
  assert.match(out, /did not quit in time; force-killed pid 100 and 1 process\(es\) it started/);
  assert.match(out, /removed the stale Temp\/UnityLockfile/);
  assert.deepEqual(world.killed.slice(0, 1), ['SIGTERM 100']);
  assert.ok(world.killed.includes('SIGKILL 100') && world.killed.includes('SIGKILL 101'));
  editor(200);
  world.killed = [];
  const r = await u.restart({ force: true });
  assert.deepEqual(world.killed.filter((k) => k.startsWith('SIGTERM')), [], 'force: no graceful step');
  assert.match(r, /force-killed pid 200/);
  assert.match(r, /Started .*Unity \(pid \d+\)/);
  assert.equal(editorsFor(world.procs, REPO).length, 1);
  assert.match(await u.status(), /^running: pid \d+/);
});

test('mac unity watch: a hung editor is restarted; a quit one left closed; a crash restarted; at most 3 in 30 min', async () => {
  const { world, editor, u } = fakeMac();
  const reports: string[] = [];
  let bridgeOk = true;
  let logSize = 1;
  let tail = '';
  const w = new MacUnityWatch(u, (t) => reports.push(t), {
    logStat: () => ({ size: logSize, mtimeMs: world.now }),
    logTail: () => tail,
    bridge: () => ({ port: 6400, reloading: false }),
    ping: async () => bridgeOk,
    now: () => world.now,
  });
  editor(100);
  assert.equal(await w.tick(), 'ok'); // up, bridge answers
  // Frozen: the bridge stops answering and the log stops growing.
  bridgeOk = false;
  assert.equal(await w.tick(), 'ok');
  world.now += 5 * 60_000;
  assert.equal(await w.tick(), 'ok', 'not long enough yet');
  world.now += 6 * 60_000;
  assert.equal(await w.tick(), 'restarted');
  assert.match(reports.at(-1)!, /hung: the Unity MCP bridge has not answered for 11 min/);
  // Quit by the user: gone, no crash evidence -> left closed.
  bridgeOk = true;
  logSize++;
  await w.tick();
  world.procs = world.procs.filter((p) => !editorsFor([p], REPO).length);
  world.now += 6 * 60_000; // past the restart's own grace
  assert.equal(await w.tick(), 'ok');
  assert.equal(editorsFor(world.procs, REPO).length, 0, 'quitting Unity is respected');
  // A crash: the editor is gone and its log ends in a crash.
  editor(300);
  await w.tick();
  world.procs = world.procs.filter((p) => p.pid !== 300 && p.ppid !== 300);
  tail = 'Obtained 42 stack frames\nReceived signal SIGSEGV';
  assert.equal(await w.tick(), 'restarted');
  assert.match(reports.at(-1)!, /crashed \(its log ends in a crash\)/);
  // A third automatic restart is allowed, the fourth within 30 min is not.
  tail = '';
  for (const pid of [400]) {
    world.procs = world.procs.filter((p) => !editorsFor([p], REPO).length);
    editor(pid);
    await w.tick();
    world.procs.push({ pid: 999, ppid: 1, cmd: `/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/Unity Bug Reporter.app/Contents/MacOS/Unity Bug Reporter --unity_project ${REPO}` });
    assert.equal(await w.tick(), 'restarted');
  }
  world.procs.push({ pid: 998, ppid: 1, cmd: `Unity Bug Reporter --unity_project ${REPO}` });
  assert.equal(await w.tick(), 'gave-up');
  assert.match(reports.at(-1)!, /already restarted 3 times in 30 min; leaving it for a person/);
});
