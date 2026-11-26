// w5924: light agent folders, agent-only work's own folder in place of a game sandbox: the daemon's store (made, listed,
// deleted, a delete refused over unpushed work), how the portal counts them apart from game sandboxes, the Capacity
// block's line, and placing again (a stopped agent-only worker in a game sandbox moves to one; one in its own folder
// resumes there; an empty folder whose work is over is deleted, one with unpushed work kept).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIGHT_DIR, LightFolders, isLightId, lightName, reposIn, scanRepos, unsavedWork, type GitRun } from '../machine/lightFolders.ts';
import { gameSandboxes, isLight, lightFolders, lightUseText } from '../shared/sandboxKind.ts';
import { capacityLines, hasRoomFor, type Computer } from './placement.ts';
import { LIGHT_GRACE_MS, PlaceAgain, movedNote } from './placeAgain.ts';
import type { Machine, MachineSandbox, SessionInfo } from '../shared/types.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Daemon } from '../machine/daemon.ts';
import { until, repos, deps, FakeAgent, PROBES } from './machineSandboxesTestKit.ts';
import type { Config } from './config.ts';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const GB = 1024 ** 3;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'w5924-'));

test('w5924: light folder ids and names: agent1, agent2, ...; the first free one', () => {
  assert.equal(lightName([]), 'agent1');
  assert.equal(lightName(['agent1', 'agent3']), 'agent2');
  assert.ok(isLightId('agent12'));
  assert.ok(!isLightId('slot1'), 'a game sandbox is not a light folder');
  assert.ok(!isLightId('agent1/../slot1'), 'no path in an id');
  assert.ok(!isLightId(undefined));
});

test('w5924: the daemon store makes, lists and deletes light folders inside the sandbox root, nowhere else', async () => {
  const root = tmp();
  try {
    const lf = new LightFolders({ root: () => root, git: async () => ({ code: 0, stdout: '', stderr: '' }) });
    assert.equal(lf.dir(), path.join(root, LIGHT_DIR));
    assert.deepEqual(lf.list(), [], 'none before the first is made');
    assert.match(lf.create('agent1'), /^Made light folder agent1/);
    assert.match(lf.create('agent1'), /is there already; kept as it is/, 'idempotent');
    lf.create('agent2');
    const list = lf.list();
    assert.deepEqual(
      list.map((s) => [s.id, s.kind, s.status, s.unity.state, s.path]),
      [
        ['agent1', 'light', 'ready', 'stopped', path.join(root, LIGHT_DIR, 'agent1')],
        ['agent2', 'light', 'ready', 'stopped', path.join(root, LIGHT_DIR, 'agent2')],
      ],
    );
    assert.throws(() => lf.create('slot1'), /not a light folder id/);
    assert.throws(() => lf.create('../escape'), /not a light folder id/);
    assert.match(await lf.remove('agent2'), /^Deleted light folder agent2/);
    assert.ok(!fs.existsSync(path.join(root, LIGHT_DIR, 'agent2')));
    assert.match(await lf.remove('agent9'), /nothing to delete/);
    assert.deepEqual(new LightFolders({ root: () => undefined }).list(), [], 'no sandbox root: no light folders');
    assert.throws(() => new LightFolders({ root: () => undefined }).create('agent1'), /no sandbox_root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('w5924: a light folder whose clone holds unpushed commits, uncommitted files or a stash is never deleted (force aside)', async () => {
  const root = tmp();
  try {
    const repo = path.join(root, LIGHT_DIR, 'agent1', 'ff-factory');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, LIGHT_DIR, 'agent1', 'node_modules', 'x', '.git'), { recursive: true });
    assert.deepEqual(reposIn(path.join(root, LIGHT_DIR, 'agent1')), [repo], 'node_modules is not searched');
    // w6031 (the w6027 review): a clone 4 levels down, or one named like a build cache, is found too; deeper is unsure.
    const a3 = path.join(root, LIGHT_DIR, 'agent3');
    const deep = path.join(a3, 'a', 'b', 'c', 'd');
    const build = path.join(a3, 'build');
    for (const r of [deep, build]) fs.mkdirSync(path.join(r, '.git'), { recursive: true });
    fs.writeFileSync(path.join(a3, 'a', 'b', 'c', 'note.txt'), 'x');
    fs.mkdirSync(path.join(a3, 'a', 'b', 'c', 'files'), { recursive: true });
    fs.writeFileSync(path.join(a3, 'a', 'b', 'c', 'files', 'f.txt'), 'x');
    fs.mkdirSync(path.join(a3, 'x', 'y', 'z', 'w', 'v', 'repo', '.git'), { recursive: true });
    fs.mkdirSync(path.join(a3, 'node_modules', 'pkg', 'lib'), { recursive: true });
    const scan = scanRepos(a3);
    assert.deepEqual([...scan.repos].sort(), [build, deep].sort(), 'the clone 4 levels down and the one named build');
    assert.deepEqual(scan.unsure, [path.join(a3, 'x', 'y', 'z', 'w')], 'past the depth with folders inside: unsure; a folder of files only is not');
    const none: GitRun = async () => ({ code: 0, stdout: '', stderr: '' });
    assert.deepEqual(await unsavedWork(a3, none), [`${path.join('x', 'y', 'z', 'w')}: holds folders deeper than the scan looks for clones`]);
    await assert.rejects(new LightFolders({ root: () => root, git: none }).remove('agent3'), /delete refused: light folder agent3/, 'unsure: never deleted');
    assert.ok(fs.existsSync(deep));
    const answers: Record<string, string> = { status: ' M a.ts\n?? b.ts\n', log: 'abc1234 wip\n', stash: 'stash@{0}: x\n' };
    const git: GitRun = async (_cwd, args) => ({ code: 0, stdout: answers[args[0]] ?? '', stderr: '' });
    assert.deepEqual(await unsavedWork(path.join(root, LIGHT_DIR, 'agent1'), git), ['ff-factory: 2 uncommitted or untracked file(s), 1 commit(s) on no remote branch, 1 stash entr(ies)']);
    const lf = new LightFolders({ root: () => root, git });
    await assert.rejects(lf.remove('agent1'), /delete refused: light folder agent1 holds work its remotes lack \(ff-factory: 2 uncommitted.*\); nothing was deleted/);
    assert.ok(fs.existsSync(repo), 'kept whole');
    const broken: GitRun = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
    await assert.rejects(new LightFolders({ root: () => root, git: broken }).remove('agent1'), /git could not read it \(fatal: not a git repository\)/, 'a repo git cannot read counts as unsaved');
    const clean: GitRun = async () => ({ code: 0, stdout: '', stderr: '' });
    assert.match(await new LightFolders({ root: () => root, git: clean }).remove('agent1'), /^Deleted/, 'pushed and clean: deleted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const sandbox = (id: string, over: Partial<MachineSandbox> = {}): MachineSandbox => ({
  id,
  branch: `sandbox/${id}`,
  base: 'origin/master',
  path: `/sb/${id}`,
  purpose: id,
  status: 'ready',
  createdAt: iso(NOW - 86_400_000),
  unity: { state: 'stopped' },
  sessionIds: [],
  git: { branch: `feature/${id}`, dirty: 0, untracked: 0, at: iso(NOW - MIN) },
  ...over,
});
const light = (id: string, over: Partial<MachineSandbox> = {}): MachineSandbox => ({ ...sandbox(id), kind: 'light', branch: '', base: '', path: `/sb/agent-work/${id}`, git: undefined, ...over });

test('w5924: light folders are counted apart from game sandboxes, and said so', () => {
  const list = [sandbox('slot1'), light('agent1'), sandbox('slot2'), light('agent2')];
  assert.deepEqual(gameSandboxes(list).map((s) => s.id), ['slot1', 'slot2']);
  assert.deepEqual(lightFolders(list).map((s) => s.id), ['agent1', 'agent2']);
  assert.ok(isLight(light('agent1')) && !isLight(sandbox('slot1')) && !isLight(undefined));
  assert.match(lightUseText([true, false], true), /^2 \(1 in use, 1 free\); a new one is made for each agent-only start/);
  assert.match(lightUseText([], true), /^none now; /);
  assert.match(lightUseText([], false), /makes no new ones/);
});

test('w5924: a computer whose game sandboxes are all full but with an agent slot free takes agent-only work, and the Capacity block says so', () => {
  const full: Computer = { id: 'lothdesktop', online: true, live: 4, midTurn: 2, maxAgents: 8, sandboxes: 4, maxSandboxes: 4, freeSandboxes: 0, memUsedBytes: 30 * GB, memTotalBytes: 64 * GB, editors: 2, maxEditors: 3, light: { folders: 2, inUse: 1 } };
  assert.equal(hasRoomFor(full, 'game'), false, 'no game sandbox free, none to make');
  assert.equal(hasRoomFor(full, 'agent'), true, 'light folders: the agent cap alone (agentSeats unset)');
  const line = capacityLines([full]).find((l) => l.startsWith('- lothdesktop'))!;
  assert.match(line, /agent slot: free \(2 of 8 mid-turn\)/);
  assert.match(line, /; light folders: 1 free of 2, a new one made per agent-only start$/);
  // At the agent cap: no room for agent work either.
  assert.equal(hasRoomFor({ ...full, midTurn: 8 }, 'agent'), false);
});

const worker = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  machineId: 'pc',
  machineSandbox: 'slot1',
  title: id,
  status: 'stopped',
  permissionMode: 'default',
  createdAt: iso(NOW - 3600 * 1000),
  lastActivityAt: iso(NOW - 20 * MIN),
  turns: 3,
  costUsd: 1,
  pendingPermissions: [],
  ...over,
});

function kit(sessions: SessionInfo[], sandboxes: MachineSandbox[], o: { workOver?: (s: SessionInfo) => string | undefined; dropLight?: (m: string, id: string) => Promise<unknown>; light?: boolean } = {}) {
  const machine = { id: 'pc', online: true, sandboxes } as unknown as Machine;
  const made: string[] = [];
  const notes: string[] = [];
  const reports: string[] = [];
  let drained = 0;
  const p = new PlaceAgain({
    sessions: () => sessions,
    machine: () => machine,
    machines: () => [machine],
    isLive: () => false,
    online: () => true,
    unityHolders: () => [],
    workOver: o.workOver ?? (() => undefined),
    keepLive: () => undefined,
    queued: () => true,
    stopLive: () => undefined,
    stopEditor: async () => undefined,
    switchBranch: async () => ({ notes: [] }),
    save: () => undefined,
    saveMachine: () => undefined,
    note: (_id, text) => void notes.push(text),
    report: (text) => void reports.push(text),
    drain: () => void drained++,
    now: () => NOW,
    agentOnly: () => true,
    seats: () => 2,
    light: () => o.light ?? true,
    makeLight: async (_m, why) => {
      const sb = light(`agent${sandboxes.filter(isLight).length + 1}`, { createdAt: iso(NOW) });
      sandboxes.push(sb);
      made.push(`${sb.id}: ${why}`);
      return sb;
    },
    ...(o.dropLight ? { dropLight: o.dropLight } : {}),
  });
  return { p, machine, made, notes, reports, drained: () => drained };
}

test('w5924: an agent-only worker stopped in a game sandbox moves to a new light folder when it next resumes; its branch there is untouched', async () => {
  const w = worker('w1', { machineSandbox: 'slot1' });
  const k = kit([w], [sandbox('slot1', { sessionIds: ['w1'] })]);
  assert.match(k.p.answer(w) ?? '', /being placed in a new light agent folder on pc/);
  assert.match(k.p.answer(w) ?? '', /being placed again in pc\/a new light folder/, 'once');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.machineSandbox, 'agent1');
  assert.equal(w.placeReleased, undefined);
  assert.deepEqual(w.movedFrom && [w.movedFrom.sandbox, w.movedFrom.light, w.movedFrom.branch], ['slot1', true, 'feature/slot1']);
  assert.deepEqual(k.machine.sandboxes!.map((s) => [s.id, s.sessionIds]), [['slot1', []], ['agent1', ['w1']]]);
  assert.match(k.notes.at(-1) ?? '', /Placed again in its own light agent folder pc\/agent1 .*it was in pc\/slot1, whose branch feature\/slot1 is untouched/);
  assert.equal(k.drained(), 1);
  const said = movedNote({ id: 'pc' }, w.movedFrom!, { id: 'agent1', path: '/sb/agent-work/agent1' });
  assert.match(said, /you now work in a light agent folder of your own, pc\/agent1/);
  assert.match(said, /Your temp folder \(\$TMPDIR\) and the clones in it are as you left them/);
  // Back in its own light folder, it resumes there, nothing made.
  w.placeReleased = { at: iso(NOW), sandbox: 'agent1', branch: '', why: 'far' };
  assert.equal(k.p.answer(w), undefined);
  assert.equal(w.machineSandbox, 'agent1');
  assert.equal(k.made.length, 1);
});

test('w5924: nothing moves while the worker runs or holds a permission, or where its daemon makes no light folders; game work never moves', () => {
  const running = worker('r', { status: 'running' });
  const asking = worker('a', { pendingPermissions: [{ id: 'p1' } as never] });
  const k = kit([running, asking], [sandbox('slot1', { sessionIds: ['r', 'a'] })]);
  assert.equal(k.p.answer(running), undefined);
  assert.equal(k.p.answer(asking), undefined);
  assert.equal(running.placeReleased ?? asking.placeReleased, undefined);
  const old = worker('o');
  const noLight = kit([old], [sandbox('slot1', { sessionIds: ['o'] })], { light: false });
  assert.equal(noLight.p.answer(old), undefined, 'an old daemon: it resumes in its game sandbox, as before');
  assert.equal(old.machineSandbox, 'slot1');
  // A new worker's first turn starts where start_agent put it (extra_agent beside another worker): it is not moved.
  const fresh = worker('f', { turns: 0, sdkSessionId: undefined });
  const first = kit([fresh], [sandbox('slot1', { sessionIds: ['f'] })]);
  assert.equal(first.p.answer(fresh), undefined);
  assert.equal(fresh.placeReleased, undefined);
  assert.equal(fresh.machineSandbox, 'slot1');
});

test('w5924: the release pass never releases a light folder; it deletes an empty one whose work is over, keeps a new one and one with unpushed work', async () => {
  const done = worker('d', { machineSandbox: 'agent1', wakeAt: iso(NOW + 9 * 3600_000) });
  const open = worker('o', { machineSandbox: 'agent2', wakeAt: iso(NOW + 9 * 3600_000) });
  const sbs = [sandbox('slot1'), light('agent1', { sessionIds: ['d'] }), light('agent2', { sessionIds: ['o'] }), light('agent3', { createdAt: iso(NOW - LIGHT_GRACE_MS + MIN) }), light('agent4')];
  const dropped: string[] = [];
  let refuse = true;
  const k = kit([done, open], sbs, {
    workOver: (s) => (s.id === 'd' ? 'its request is closed (w1 done)' : undefined),
    dropLight: async (_m, id) => {
      if (id === 'agent4' && refuse) throw new Error('delete refused: light folder agent4 holds work its remotes lack (x: 1 commit(s) on no remote branch); nothing was deleted');
      dropped.push(id);
      sbs.splice(sbs.findIndex((s) => s.id === id), 1);
    },
  });
  const did = k.p.tick();
  assert.equal(open.placeReleased, undefined, 'a far check-in releases no light folder: it is its own');
  assert.ok(did.some((l) => /deleting the light agent folder pc\/agent1: its worker d stopped with its work over/.test(l)));
  assert.ok(did.some((l) => /deleting the light agent folder pc\/agent4: no worker is in it/.test(l)));
  assert.ok(!did.some((l) => /agent2|agent3/.test(l)), 'open work and a new folder stay');
  assert.match(done.placeReleased?.why ?? '', /light agent folder was deleted/, 'a reopen places it in a new one');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(dropped, ['agent1']);
  assert.match(k.reports.join('\n'), /the light agent folder pc\/agent4 is kept: delete refused/);
  // Refused once: not tried again on every pass, and said once.
  refuse = false;
  k.p.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(dropped, ['agent1']);
  assert.ok(!dropped.includes('agent4'));
  assert.equal(k.reports.filter((t) => /agent4/.test(t)).length, 1);
});

// ---------------------------------------------------------------- the portal and a real daemon (machineSandboxesTestKit)

test('w5924: through a real daemon: its hello offers light folders; the portal makes one, sees it apart from the game sandboxes, and deletes it', async (t) => {
  const r = repos();
  const cfg = { dataDir: path.join(r.root, 'data'), limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' }, defaultBase: 'origin/master' } as unknown as Config;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = new Store(cfg.dataDir);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  mm.hooks = { specFor: () => ({ cwd: r.main, settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: r.main, protectedPaths: [], gameRepos: [] } }), handlersFor: () => ({}) };
  mm.cleanupFor = () => ({ everyMinutes: 0, softFreeGB: 0, staleOutput: { nightlyRoots: [] } });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'pc', host: 'pc', purpose: 'unused', status: 'ready', repoPath: r.main, home: r.root, portalUrl: url, sandboxRoot: r.sbRoot, maxSandboxes: 1, maxAgentsPerSandbox: 1, maxUnity: 1 });
  const { d: poolDeps } = deps(r.main);
  const daemon = new Daemon({ portalUrl: url, id: 'pc', token, repoPath: r.main, appDir: path.join(r.root, 'app'), claude: 'no-such-claude', maxSessions: 1, maxEventsFile: null, sandboxCacheTrim: false }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES, poolDeps);
  t.after(async () => {
    daemon.shutdown();
    server.close();
    await until('the daemon gone', () => !mm.isOnline('pc'), 5000).catch(() => undefined);
    store.flush();
    await store.saved();
    r.cleanup();
  });
  daemon.start();
  await until('online with hello', () => mm.isOnline('pc') && !!store.machines.get('pc')?.info);
  assert.equal(mm.offersLight('pc'), true);
  // Its one game sandbox made: the pool is full for game work.
  await mm.createSandbox('pc', { name: 'sb1' });
  await until('sb1 ready', () => store.machines.get('pc')?.sandboxes?.find((s) => s.id === 'sb1')?.status === 'ready');
  await assert.rejects(mm.createSandbox('pc', { name: 'sb2' }), /max_sandboxes|limit|1 of 1|full/i, 'no second game sandbox');
  // A light folder is made all the same, inside the sandbox root, and listed apart.
  const a = await mm.createLightFolder('pc', 'w9001');
  assert.equal(a.id, 'agent1');
  assert.equal(a.kind, 'light');
  assert.equal(path.resolve(a.path), path.resolve(path.join(r.sbRoot, LIGHT_DIR, 'agent1')));
  assert.ok(fs.statSync(a.path).isDirectory());
  const b = await mm.createLightFolder('pc', 'w9002');
  assert.equal(b.id, 'agent2');
  const m = store.machines.get('pc')!;
  assert.deepEqual(gameSandboxes(m.sandboxes).map((s) => s.id), ['sb1']);
  assert.deepEqual(lightFolders(m.sandboxes).map((s) => s.id), ['agent1', 'agent2']);
  await assert.rejects(mm.unity('pc', 'start', false, 'agent1'), /light agent folder \(w5924\).*no Unity editor/);
  await assert.rejects(mm.deleteLightFolder('pc', 'sb1'), /is a game sandbox, not a light folder/);
  // A clone with an unpushed commit keeps it; once gone, the folder is deleted.
  const clone = path.join(b.path, 'repo');
  execFileSync('git', ['init', '-q', clone]);
  execFileSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'wip']);
  await assert.rejects(mm.deleteLightFolder('pc', 'agent2'), /delete refused: light folder agent2 holds work its remotes lack \(repo: 1 commit\(s\) on no remote branch\)/);
  assert.ok(fs.existsSync(clone));
  await mm.deleteLightFolder('pc', 'agent1');
  assert.ok(!fs.existsSync(a.path));
  await until('agent1 gone from the store', () => !store.machines.get('pc')!.sandboxes!.some((s) => s.id === 'agent1'));
  assert.deepEqual(gameSandboxes(store.machines.get('pc')!.sandboxes).map((s) => s.id), ['sb1'], 'the game sandbox untouched');
});
