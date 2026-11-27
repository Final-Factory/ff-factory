import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHARED_LOCK_TOOLS, SHARED_SEED_DIRS, WORKER_CACHE_CHILDREN, makeSharedLockDirs, sharedLockParents, sharedLockPaths } from '../machine/sharedLockPaths.ts';
import { SLOT_CACHE_TOOLS, mergeBack } from '../machine/slotCaches.ts';
import { MEDIUM_TOOLS, LowCopies, isExplicitMedium, isLabelledLow, labelLow, lowTargets, type Exec } from '../machine/lowIntegrity.ts';
import { FF_LANDLOCK, writeLockArgs } from '../machine/writeLock.ts';
import { fenceFor, seatbeltProfile } from './workerFence.ts';
import { firstUnplain, lockIn } from '../machine/lockIn.ts';

// w5615 (stage 2 of w5544): the shared lock "on" keeps the cache seeds, players, seed and tools/node, low and unity-low from
// sandbox workers on every OS, and "off" gives them back.

function tmp(t: TestContext): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w5615-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const put = (p: string, text = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

test('one list: the seeds are the slot caches\' folders and the tools are the ones Windows keeps Medium', () => {
  assert.deepEqual([...SHARED_SEED_DIRS].sort(), SLOT_CACHE_TOOLS.map((t) => t.dir.split(path.sep).join('/')).sort());
  assert.deepEqual([...SHARED_LOCK_TOOLS].sort(), [...MEDIUM_TOOLS].sort());
  const parents = sharedLockParents();
  assert.deepEqual([...parents.keys()].sort(), ['cache', 'cache/nuget', 'tools']);
  assert.deepEqual([...parents.get('cache')!].sort(), ['dotnet', 'ms-playwright', 'npm', 'nuget', 'pip', 'upm', 'uv']);
  assert.deepEqual([...parents.get('cache/nuget')!], ['packages']);
  for (const c of WORKER_CACHE_CHILDREN) assert.ok(!parents.get('cache')!.has(c), `${c} stays the workers'`);
});

test('makeSharedLockDirs makes the workers\' cache children and the folders on the way, and never throws', (t) => {
  const root = tmp(t);
  makeSharedLockDirs(root);
  for (const c of WORKER_CACHE_CHILDREN) assert.ok(fs.statSync(path.join(root, 'cache', c)).isDirectory(), c);
  assert.ok(fs.statSync(path.join(root, 'cache', 'nuget')).isDirectory());
  makeSharedLockDirs(root, () => {
    throw new Error('EACCES');
  });
});

test('macOS: "on" denies each locked path inside the root; off and warn do not', () => {
  const root = path.resolve('/Users/p/ffw');
  const mac = (sharedLock: boolean) => fenceFor({ setting: 'seatbelt', root, platform: 'darwin', home: '/Users/p', sharedLock, exists: () => true, getconf: (n) => `/t/${n}` })!;
  const subpath = (p: string) => `(subpath ${JSON.stringify(p)})`;
  // The read-only deny block (players and seed are named in the write allows too, which a later deny overrides).
  const denies = (s: string) => s.slice(s.indexOf(';; inside the root, read-only for workers'), s.indexOf('\n)', s.indexOf(';; inside the root, read-only for workers')));
  const on = seatbeltProfile(mac(true));
  const off = seatbeltProfile(mac(false));
  for (const rel of ['cache/uv', 'cache/nuget/packages', 'players', 'seed', 'tools/node']) {
    const rule = subpath(path.posix.join(root, rel));
    assert.ok(denies(on).includes(rule), `on: ${rel} denied`);
    assert.ok(!denies(off).includes(rule), `off: ${rel} not denied`);
  }
  // The denies come after the root's allow (later Seatbelt rules win).
  assert.ok(on.indexOf(denies(on)) > on.indexOf(subpath(root)));
});

test('Linux: "on" leaves players and seed out and opens only the other children of cache, cache/nuget and tools', (t) => {
  const root = tmp(t);
  for (const d of ['cache/uv', 'cache/slots', 'cache/nuget/packages', 'cache/nuget/other', 'tools/node', 'tools/git', 'players', 'seed', 'sandboxes']) fs.mkdirSync(path.join(root, ...d.split('/')), { recursive: true });
  const on = writeLockArgs({ root, sharedLock: true });
  const off = writeLockArgs({ root });
  const rw = (a: string[]) => a.flatMap((x, i) => (x === '--rw' ? [a[i + 1]] : []));
  for (const c of ['players', 'seed', 'cache', 'tools']) {
    assert.ok(rw(off).includes(path.join(root, c)), `off: ${c} writable`);
    assert.ok(!rw(on).includes(path.join(root, c)), `on: ${c} not writable whole`);
  }
  assert.ok(rw(on).includes(path.join(root, 'sandboxes')));
  const children = (dir: string) => {
    const i = on.findIndex((x, k) => x === '--rw-children' && on[k + 1] === path.join(root, ...dir.split('/')));
    assert.ok(i >= 0, `--rw-children ${dir}`);
    const out: string[] = [];
    for (let k = i + 2; on[k] === '--except'; k += 2) out.push(on[k + 1]);
    return out;
  };
  assert.deepEqual(children('cache'), ['dotnet', 'ms-playwright', 'npm', 'nuget', 'pip', 'upm', 'uv']);
  assert.deepEqual(children('cache/nuget'), ['packages']);
  assert.deepEqual(children('tools'), ['low', 'node', 'unity-low']);
  assert.ok(!off.includes('--rw-children') || !off.includes(path.join(root, 'cache')));
});

const W = path.resolve('/ffw');
const kids = ['cache', 'players', 'seed', 'sandboxes', 'tools'].map((name) => ({ name, dir: true }));
const listing: Record<string, string[]> = {
  [path.join(W, 'cache')]: ['uv', 'pip', 'nuget', 'slots', 'uv-tools', 'cargo'],
  [path.join(W, 'cache', 'nuget')]: ['packages', 'v3-cache'],
};
const list = (d: string) => (listing[d] ?? []).map((name) => ({ name, dir: true }));
const targets = (sharedLock: boolean) =>
  lowTargets({ root: W, appDir: path.join(W, 'daemon'), children: kids, toolsChildren: ['node', 'low', 'git'].map((name) => ({ name, dir: true })), exists: () => true, sharedLock, list });

test('Windows: "on" keeps cache and cache/nuget Medium with their other children Low on their own, and labels the locked folders Medium whole', () => {
  const on = targets(true);
  for (const rel of ['cache', 'cache/nuget', 'cache/uv', 'cache/pip', 'cache/nuget/packages', 'players', 'seed']) {
    const p = path.join(W, ...rel.split('/'));
    assert.ok(on.medium.includes(p), `on: ${rel} Medium`);
    assert.ok(!on.dirs.includes(p), `on: ${rel} not Low`);
  }
  for (const rel of ['cache/slots', 'cache/uv-tools', 'cache/cargo', 'cache/nuget/v3-cache', 'sandboxes', 'tools/git']) assert.ok(on.dirs.includes(path.join(W, ...rel.split('/'))), `on: ${rel} Low`);
  assert.deepEqual(new Set(on.trees), new Set(sharedLockPaths(W, false)));
  // A seed nobody has made yet is still Medium-labelled once it exists (lowTargets names it; labelLow skips a missing one).
  assert.ok(on.medium.includes(path.join(W, 'cache', 'dotnet')));
});

test('Windows: off (and warn) labels the locked folders and the folders on the way Low again, whole, where "on" left them Medium', () => {
  const off = targets(false);
  for (const rel of ['cache', 'cache/uv', 'cache/nuget', 'cache/nuget/packages', 'players', 'seed']) assert.ok(off.dirs.includes(path.join(W, ...rel.split('/'))), `off: ${rel} Low`);
  for (const rel of ['cache/uv', 'players', 'seed']) assert.ok(off.trees.includes(path.join(W, ...rel.split('/'))), `off: ${rel} whole`);
  assert.ok(!off.medium.some((m) => m.startsWith(path.join(W, 'cache'))));
  assert.ok(!off.medium.includes(path.join(W, 'players')));
});

test('a shared-lock folder counts as locked only with a Medium label of its own, not one it inherits', () => {
  const p = path.join(W, 'players');
  assert.equal(isExplicitMedium(`${p} Mandatory Label\\Medium Mandatory Level:(I)(OI)(CI)(NW)`), false);
  assert.equal(isExplicitMedium(`${p} Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)`), true);
  assert.equal(isExplicitMedium(`${p} Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)`), false);
});

test('firstUnplain finds a symlink or a file with a second name; lockIn removes such an entry and keeps a plain one', async (t) => {
  const d = tmp(t);
  put(path.join(d, 'plain', 'a', 'f'));
  assert.equal(firstUnplain(path.join(d, 'plain')), undefined);
  put(path.join(d, 'hard', 'f'));
  fs.linkSync(path.join(d, 'hard', 'f'), path.join(d, 'elsewhere'));
  assert.equal(firstUnplain(path.join(d, 'hard')), path.join(d, 'hard', 'f'));
  fs.mkdirSync(path.join(d, 'sym'));
  fs.mkdirSync(path.join(d, 'target'));
  fs.symlinkSync(path.join(d, 'target'), path.join(d, 'sym', 'l'), 'junction');
  assert.equal(firstUnplain(path.join(d, 'sym')), path.join(d, 'sym', 'l'));
  const said: string[] = [];
  const deps = { platform: 'linux' as const, exec: async () => ({ code: 0, stdout: '', stderr: '' }), removeTree: async (p: string) => fs.rmSync(p, { recursive: true, force: true }), log: (l: string) => void said.push(l) };
  assert.equal(await lockIn(path.join(d, 'plain'), deps), true);
  assert.equal(await lockIn(path.join(d, 'hard'), deps), false);
  assert.ok(!fs.existsSync(path.join(d, 'hard')));
  assert.equal(fs.readFileSync(path.join(d, 'elsewhere'), 'utf8'), 'x', 'the other name stays');
  assert.equal(await lockIn(path.join(d, 'sym'), deps), false);
  assert.ok(fs.existsSync(path.join(d, 'target')), 'the link goes, not what it pointed at');
  assert.match(said.join('\n'), /removed .*hard again/);
  // Windows: the entry is labelled Medium whole first; a failed icacls removes it.
  const calls: string[][] = [];
  put(path.join(d, 'win', 'f'));
  assert.equal(await lockIn(path.join(d, 'win'), { ...deps, platform: 'win32', exec: async (_c, a) => (calls.push(a), { code: 0, stdout: '', stderr: '' }) }), true);
  assert.deepEqual(calls[0].slice(1), ['/setintegritylevel', '(OI)(CI)medium', '/T', '/C', '/Q']);
  assert.equal(await lockIn(path.join(d, 'win'), { ...deps, platform: 'win32', exec: async () => ({ code: 5, stdout: '', stderr: 'Access is denied.' }) }), false);
  assert.ok(!fs.existsSync(path.join(d, 'win')));
});

test('mergeBack under "on" counts an entry only once it is locked in; one lockIn refuses is not counted', async (t) => {
  const d = tmp(t);
  const clone = path.join(d, 'clone');
  const seed = path.join(d, 'seed');
  put(path.join(clone, 'archive-v0', 'h1', 'f'));
  put(path.join(clone, 'archive-v0', 'h2', 'f'));
  fs.mkdirSync(seed);
  const rule = { dirs: [{ top: /^archive-v\d+$/, depth: 1 }] };
  const copy = async (s: string, dst: string) => fs.cpSync(s, dst, { recursive: true });
  const locked: string[] = [];
  const lock = async (dst: string) => {
    locked.push(path.basename(dst));
    if (path.basename(dst) === 'h2') {
      fs.rmSync(dst, { recursive: true, force: true });
      return false;
    }
    return true;
  };
  assert.equal(await mergeBack(clone, seed, rule, copy, Date.now() + 3600_000, undefined, path.join(d, 'stage'), lock), 1);
  assert.deepEqual(locked.sort(), ['h1', 'h2']);
  assert.deepEqual(fs.readdirSync(path.join(seed, 'archive-v0')), ['h1']);
});

// ---------------------------------------------------------------- live

const realExec: Exec = async (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } as never;
};
/** A Low cmd.exe running one line (storeLock.test.ts lowShell: windowsVerbatimArguments, or every line fails). */
const lowShell = (cmd: string) => (line: string) => spawnSync(cmd, ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
const runsLow = process.platform === 'win32' && /S-1-16-4096/.test(spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/groups'], { encoding: 'utf8', windowsHide: true }).stdout ?? '');

test('live (Windows): "on" refuses a Low process in cache/uv (its own earlier file too), players and seed and a rename of cache/uv, while it writes cache/slots; off gives them back', { skip: process.platform !== 'win32' ? 'needs Windows' : runsLow && 'needs a Medium process: this one runs Low' }, async (t) => {
  const base = tmp(t);
  const root = path.join(base, 'root');
  for (const d of ['cache/uv', 'cache/nuget/packages', 'players/slot1-0/player', 'seed', 'sandboxes', 'tools/git']) fs.mkdirSync(path.join(root, ...d.split('/')), { recursive: true });
  makeSharedLockDirs(root);
  const children = fs.readdirSync(root, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  const toolsChildren = fs.readdirSync(path.join(root, 'tools'), { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  const tg = (sharedLock: boolean) => lowTargets({ root, appDir: path.join(root, 'daemon'), children, toolsChildren, sharedLock });
  const said: string[] = [];
  assert.equal(await labelLow(tg(false), realExec, (l) => void said.push(l)), true, said.join('\n'));
  const cmd = new LowCopies(base, (l: string) => void said.push(l)).make(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'));
  assert.ok(cmd, said.join('\n'));
  const low = lowShell(cmd!);
  const uvOld = path.join(root, 'cache', 'uv', 'old.txt');
  assert.equal(low(`echo x> "${uvOld}"`).status, 0, 'off: a Low write into cache/uv');
  assert.ok(fs.existsSync(uvOld), 'the shell really ran the line');

  assert.equal(await labelLow(tg(true), realExec, (l) => void said.push(l)), true, said.join('\n'));
  assert.ok(isExplicitMedium((await realExec('icacls', [path.join(root, 'cache', 'uv')])).stdout));
  const refusedLines = [
    `echo y>> "${uvOld}"`,
    `echo x> "${path.join(root, 'cache', 'uv', 'new.txt')}"`,
    `echo x> "${path.join(root, 'players', 'slot1-0', 'player', 'Game.exe')}"`,
    `echo x> "${path.join(root, 'seed', 'x.txt')}"`,
    `echo x> "${path.join(root, 'cache', 'new.txt')}"`,
    `ren "${path.join(root, 'cache', 'uv')}" uv2`,
    `ren "${path.join(root, 'cache', 'nuget', 'packages')}" p2`,
  ];
  for (const line of refusedLines) assert.notEqual(low(line).status, 0, `on: refused: ${line}`);
  assert.equal(fs.readFileSync(uvOld, 'utf8').trim(), 'x');
  assert.ok(fs.existsSync(path.join(root, 'cache', 'uv')) && !fs.existsSync(path.join(root, 'cache', 'uv2')));
  for (const p of ['cache/slots/s.txt', 'cache/uv-tools/t.txt', 'sandboxes/s.txt', 'tools/git/g.txt']) {
    const r = low(`echo x> "${path.join(root, ...p.split('/'))}"`);
    assert.equal(r.status, 0, `on: a Low write into ${p}: ${r.stderr}`);
  }
  // lockIn: what a Low copy put in a stage, moved into the seed by the daemon, turns Medium whole.
  const stage = path.join(root, 'cache', 'slots', 'h9');
  assert.equal(low(`mkdir "${stage}" && echo x> "${path.join(stage, 'f')}"`).status, 0);
  const dst = path.join(root, 'cache', 'uv', 'h9');
  fs.renameSync(stage, dst);
  assert.equal(low(`echo y>> "${path.join(dst, 'f')}"`).status, 0, 'before lockIn the moved file is still the Low copy\'s');
  assert.equal(await lockIn(dst, { exec: realExec, removeTree: async (p) => fs.rmSync(p, { recursive: true, force: true }) }), true);
  assert.notEqual(low(`echo z>> "${path.join(dst, 'f')}"`).status, 0, 'after lockIn: refused');

  // The way back: shared_lock off and the next labelling.
  assert.equal(await labelLow(tg(false), realExec, (l) => void said.push(l)), true, said.join('\n'));
  assert.ok(isLabelledLow((await realExec('icacls', [path.join(root, 'cache', 'uv')])).stdout));
  for (const line of [`echo y>> "${uvOld}"`, `echo y>> "${path.join(dst, 'f')}"`, `echo x> "${path.join(root, 'players', 'slot1-0', 'player', 'Game.exe')}"`, `echo x> "${path.join(root, 'seed', 'x.txt')}"`, `echo x> "${path.join(root, 'cache', 'new.txt')}"`]) {
    const r = low(line);
    assert.equal(r.status, 0, `off again: ${line}: ${r.stderr}`);
  }
});

const python3 = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0;
const landlock = process.platform === 'linux' && python3 && spawnSync('python3', [FF_LANDLOCK, '--rw', os.tmpdir(), '--', 'true'], { encoding: 'utf8' }).status === 0;

test('live (Linux): under "on" Landlock refuses writes to cache/uv, players, seed and a rename of cache/uv, while cache/slots is written; off writes them all', { skip: !landlock && 'needs Landlock and python3' }, (t) => {
  const root = tmp(t);
  for (const d of ['cache/uv', 'cache/nuget/packages', 'players/slot1-0', 'seed', 'sandboxes', 'tools/git']) fs.mkdirSync(path.join(root, ...d.split('/')), { recursive: true });
  makeSharedLockDirs(root);
  const r = (p: string) => path.join(root, ...p.split('/'));
  const script = [
    'try() { if sh -c "$2" 2>/dev/null; then echo "$1 ok"; else echo "$1 refused"; fi; }',
    `try uv "echo x > ${r('cache/uv/x')}"`,
    `try players "echo x > ${r('players/slot1-0/x')}"`,
    `try seed "echo x > ${r('seed/x')}"`,
    `try packages "echo x > ${r('cache/nuget/packages/x')}"`,
    `try mv-uv "mv ${r('cache/uv')} ${r('cache/slots/uv')}"`,
    `try slots "echo x > ${r('cache/slots/x')}"`,
    `try tools-git "echo x > ${r('tools/git/x')}"`,
    `try sandboxes "echo x > ${r('sandboxes/x')}"`,
  ].join('\n');
  const run = (sharedLock: boolean) => spawnSync('python3', [FF_LANDLOCK, ...writeLockArgs({ root, sharedLock, extra: ['/dev/null'] }), '--', 'bash', '-c', script], { encoding: 'utf8' });
  const on = run(true);
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(on.stdout.trim().split('\n'), ['uv refused', 'players refused', 'seed refused', 'packages refused', 'mv-uv refused', 'slots ok', 'tools-git ok', 'sandboxes ok']);
  const off = run(false);
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(off.stdout.trim().split('\n').slice(0, 4), ['uv ok', 'players ok', 'seed ok', 'packages ok']);
});
