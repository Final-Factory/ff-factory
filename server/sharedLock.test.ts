import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHARED_LOCK_TOOLS, SHARED_SEED_DIRS, WORKER_CACHE_CHILDREN, makeSharedLockDirs, sharedLockParents, sharedLockPaths } from '../machine/sharedLockPaths.ts';
import { SLOT_CACHE_TOOLS, mergeBack } from '../machine/slotCaches.ts';
import { MEDIUM_TOOLS, isExplicitMedium, isLabelledLow, labelLow, lowTargets, type Exec } from '../machine/lowIntegrity.ts';
import { FF_LANDLOCK, writeLockArgs } from '../machine/writeLock.ts';
import { fenceFor, seatbeltProfile } from './workerFence.ts';
import { firstUnplain, lockIn } from '../machine/lockIn.ts';
import { lowRunner } from './lowRunTest.ts';

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

test('makeSharedLockDirs never makes a folder through a link a worker planted at cache or cache/nuget (review w6362)', (t) => {
  const root = tmp(t);
  const made: string[] = [];
  makeSharedLockDirs(root, (p) => void made.push(p), (p) => p === path.join(root, 'cache', 'nuget'));
  assert.ok(made.includes(path.join(root, 'cache', 'slots')), JSON.stringify(made));
  assert.ok(!made.some((p) => p.startsWith(path.join(root, 'cache', 'nuget'))), JSON.stringify(made));
  made.length = 0;
  makeSharedLockDirs(root, (p) => void made.push(p), (p) => p === path.join(root, 'cache'));
  assert.ok(!made.some((p) => p.startsWith(path.join(root, 'cache'))), `nothing under a linked cache: ${JSON.stringify(made)}`);
  // A real one: a junction on Windows (no privilege needed), a symlink elsewhere.
  const real = tmp(t);
  const outside = path.join(real, 'daemon');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(real, 'cache'));
  fs.symlinkSync(outside, path.join(real, 'cache', 'nuget'), process.platform === 'win32' ? 'junction' : 'dir');
  makeSharedLockDirs(real);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing made where the link leads');
  assert.ok(fs.statSync(path.join(real, 'cache', 'slots')).isDirectory());
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
  // Review w6362: the folders on the way are denied as themselves, so renaming one away is refused without relying on a
  // rename counting as a write to every path under it.
  for (const rel of ['cache', 'cache/nuget', 'tools']) {
    const rule = `(literal ${JSON.stringify(path.posix.join(root, rel))})`;
    assert.ok(denies(on).includes(rule), `on: ${rel} itself denied`);
    assert.ok(!denies(off).includes(rule), `off: ${rel} not denied`);
    assert.ok(!denies(on).includes(subpath(path.posix.join(root, rel))), `on: ${rel}'s other children stay writable`);
  }
});

test('live (macOS): under "on" Seatbelt refuses a rename of cache, cache/nuget and cache/uv and a write in cache/uv, while cache/slots is written', { skip: process.platform !== 'darwin' && 'needs macOS' }, (t) => {
  const root = tmp(t);
  for (const d of ['cache/uv', 'cache/nuget/packages', 'players', 'seed', 'sandboxes', 'tools/git']) fs.mkdirSync(path.join(root, ...d.split('/')), { recursive: true });
  makeSharedLockDirs(root);
  const r = (p: string) => path.join(root, ...p.split('/'));
  const script = [
    'try() { if sh -c "$2" 2>/dev/null; then echo "$1 ok"; else echo "$1 refused"; fi; }',
    `try uv "echo x > ${r('cache/uv/x')}"`,
    `try mv-cache "mv ${r('cache')} ${r('sandboxes/cache2')}"`,
    `try mv-nuget "mv ${r('cache/nuget')} ${r('cache/slots/nuget2')}"`,
    `try mv-uv "mv ${r('cache/uv')} ${r('cache/slots/uv2')}"`,
    `try mv-tools "mv ${r('tools')} ${r('sandboxes/tools2')}"`,
    `try slots "echo x > ${r('cache/slots/x')}"`,
    `try tools-git "echo x > ${r('tools/git/x')}"`,
  ].join('\n');
  const fence = fenceFor({ setting: 'seatbelt', root, platform: 'darwin', home: os.homedir(), sharedLock: true })!;
  const on = spawnSync('sandbox-exec', ['-p', seatbeltProfile(fence), 'bash', '-c', script], { encoding: 'utf8' });
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(on.stdout.trim().split('\n'), ['uv refused', 'mv-cache refused', 'mv-nuget refused', 'mv-uv refused', 'mv-tools refused', 'slots ok', 'tools-git ok']);
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

test('Windows: neither "on" nor off labels anything through a link at cache/nuget, cache/uv or among cache\'s children (review w6362)', () => {
  const links = new Set(['cache/nuget', 'cache/uv', 'cache/slots'].map((r) => path.join(W, ...r.split('/'))));
  for (const sharedLock of [true, false]) {
    const tg = lowTargets({ root: W, appDir: path.join(W, 'daemon'), children: kids, toolsChildren: ['node', 'low', 'git'].map((name) => ({ name, dir: true })), exists: () => true, sharedLock, list, isLink: (p) => links.has(p) });
    for (const l of links) {
      for (const [what, ps] of Object.entries({ dirs: tg.dirs, medium: tg.medium, trees: tg.trees })) {
        assert.ok(!ps.some((p) => p === l || p.startsWith(l + path.sep)), `${sharedLock ? 'on' : 'off'}: ${l} not in ${what}`);
      }
    }
    assert.ok(tg.trees.includes(path.join(W, 'cache', 'pip')), `${sharedLock}: the rest still labelled`);
  }
});

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

test('Windows: off (and warn) labels the locked folders Low again whole and the folders on the way alone, where "on" left them Medium', () => {
  const off = targets(false);
  for (const rel of ['cache', 'cache/uv', 'cache/nuget', 'cache/nuget/packages', 'players', 'seed']) assert.ok(off.dirs.includes(path.join(W, ...rel.split('/'))), `off: ${rel} Low`);
  for (const rel of ['cache/uv', 'players', 'seed']) assert.ok(off.trees.includes(path.join(W, ...rel.split('/'))), `off: ${rel} whole`);
  // Review w6355 H1: workers write the rest of cache (cache/slots); a walk of all of it could meet a junction they planted.
  for (const rel of ['cache', 'cache/nuget']) assert.ok(!off.trees.includes(path.join(W, ...rel.split('/'))), `off: ${rel} alone, not whole`);
  assert.ok(!off.medium.some((m) => m.startsWith(path.join(W, 'cache'))));
  assert.ok(!off.medium.includes(path.join(W, 'players')));
});

test('Windows: off labels the locked folders Low before the folders on the way, deepest first (review w6374)', () => {
  const off = targets(false);
  const at = (rel: string) => off.dirs.indexOf(path.join(W, ...rel.split('/')));
  for (const rel of ['cache', 'cache/nuget']) assert.ok(at(rel) >= 0, rel);
  // A parent Low while a locked child is still Medium lets a worker rename the child aside and plant a junction there.
  for (const p of off.trees) assert.ok(off.dirs.indexOf(p) < at('cache/nuget'), `${p} before cache/nuget: ${JSON.stringify(off.dirs)}`);
  assert.ok(at('cache/nuget') < at('cache'), JSON.stringify(off.dirs));
});

test('Windows: under "on" cache/nuget swapped for a link while it is listed names none of its children (review w6374)', () => {
  const nuget = path.join(W, 'cache', 'nuget');
  let listed = false;
  const tg = lowTargets({
    root: W,
    appDir: path.join(W, 'daemon'),
    children: kids,
    toolsChildren: ['node', 'low', 'git'].map((name) => ({ name, dir: true })),
    exists: () => true,
    sharedLock: true,
    list: (d) => {
      if (d === nuget) listed = true;
      return list(d);
    },
    isLink: (p) => listed && p === nuget,
  });
  assert.ok(listed);
  assert.ok(!tg.dirs.some((p) => p.startsWith(nuget + path.sep)), JSON.stringify(tg.dirs));
  assert.ok(tg.dirs.includes(path.join(W, 'cache', 'slots')), 'the rest of cache still Low');
});

test('Windows: labelTree to Low reads its root again after the first icacls call and refuses one swapped meanwhile (review w6374)', { skip: process.platform !== 'win32' && 'junctions are Windows only' }, async (t) => {
  const { labelTree } = await import('./transcriptLabels.ts');
  const d = tmp(t);
  const outside = path.join(d, 'outside');
  put(path.join(outside, 'deep', 's'));
  const seed = path.join(d, 'seed');
  put(path.join(seed, 'f'));
  const calls: string[][] = [];
  const swap = (a: string[]) => {
    calls.push(a);
    if (a[0] === seed && !fs.lstatSync(seed).isSymbolicLink()) {
      fs.rmSync(seed, { recursive: true });
      fs.symlinkSync(outside, seed, 'junction');
    }
    return { code: 0, out: '' };
  };
  await assert.rejects(labelTree(seed, 'low', swap, 'acct'), /turned into a junction/);
  assert.equal(calls.length, 1, JSON.stringify(calls));
});

// Review w6377: a real layout, labelled by labelLow with a fake icacls.
const realTargets = (d: string, sharedLock: boolean) =>
  lowTargets({ root: d, appDir: path.join(d, 'daemon'), children: [{ name: 'cache', dir: true }], toolsChildren: [], sharedLock });
const setCalls = (calls: string[][]) => calls.filter((a) => a.includes('/setintegritylevel')).map((a) => a[0]);

test('Windows: "on" turns cache and cache/nuget Medium before their children go Low, and labels none swapped for a junction (review w6377 A)', { skip: process.platform !== 'win32' && 'junctions are Windows only' }, async (t) => {
  const d = tmp(t);
  put(path.join(d, 'daemon', 'src', 'main.ts'));
  put(path.join(d, 'cache', 'slots', 'f'));
  put(path.join(d, 'cache', 'nuget', 'evil', 'f'));
  put(path.join(d, 'cache', 'uv', 'f'));
  const tg = realTargets(d, true);
  const slots = path.join(d, 'cache', 'slots');
  const evil = path.join(d, 'cache', 'nuget', 'evil');
  assert.ok(tg.dirs.includes(slots) && tg.dirs.includes(evil), JSON.stringify(tg.dirs));
  const calls: string[][] = [];
  const said: string[] = [];
  let swapped = false;
  const exec: Exec = async (_c, a) => {
    calls.push(a);
    if (a.includes('/setintegritylevel') && !swapped) {
      // What a Low worker could do while cache is still Low: move a child aside and plant a junction to the daemon there.
      swapped = true;
      fs.renameSync(slots, path.join(d, 'aside1'));
      fs.symlinkSync(path.join(d, 'daemon'), slots, 'junction');
      fs.renameSync(evil, path.join(d, 'aside2'));
      fs.symlinkSync(path.join(d, 'daemon', 'src'), evil, 'junction');
    }
    return { code: 0, stdout: '', stderr: '' } as never;
  };
  assert.equal(await labelLow(tg, exec, (l) => void said.push(l), 'acct'), true, said.join('\n'));
  const set = setCalls(calls);
  assert.equal(set[0], path.join(d, 'cache'), JSON.stringify(set));
  assert.equal(set[1], path.join(d, 'cache', 'nuget'), JSON.stringify(set));
  assert.ok(!set.includes(slots) && !set.includes(evil), `nothing labelled through the junctions: ${JSON.stringify(set)}`);
  assert.match(said.join('\n'), /cache.slots is \(or lies below\) a junction or symlink now, not labelled/);
  // The first of them refused, the other children of cache/nuget are labelled as before.
  assert.ok(set.includes(path.join(d, 'cache', 'uv')), JSON.stringify(set));
});

test('Windows: under "on" a folder on the way that cannot turn Medium first leaves its children as they are (review w6377 A)', async (t) => {
  const d = tmp(t);
  put(path.join(d, 'cache', 'slots', 'f'));
  put(path.join(d, 'cache', 'nuget', 'mine', 'f'));
  const tg = realTargets(d, true);
  const calls: string[][] = [];
  const said: string[] = [];
  const exec: Exec = async (_c, a) => {
    calls.push(a);
    const fail = a.includes('/setintegritylevel') && a[0] === path.join(d, 'cache');
    return { code: fail ? 1 : 0, stdout: '', stderr: fail ? 'The media is write protected.' : '' } as never;
  };
  await labelLow(tg, exec, (l) => void said.push(l), 'acct');
  const set = setCalls(calls);
  assert.ok(!set.some((p) => p.startsWith(path.join(d, 'cache') + path.sep)), JSON.stringify(set));
  assert.match(said.join('\n'), /could not keep .*cache Medium before its children/);
});

test('Windows: off leaves cache and cache/nuget Medium while a locked folder in them could not be labelled Low (review w6377 B)', async (t) => {
  const d = tmp(t);
  put(path.join(d, 'cache', 'slots', 'f'));
  put(path.join(d, 'cache', 'uv', 'f'));
  put(path.join(d, 'cache', 'nuget', 'packages', 'f'));
  const tg = realTargets(d, false);
  const uv = path.join(d, 'cache', 'uv');
  assert.ok(tg.trees.includes(uv) && tg.guard.includes(path.join(d, 'cache')), JSON.stringify(tg));
  const calls: string[][] = [];
  const said: string[] = [];
  const exec: Exec = async (_c, a) => {
    calls.push(a);
    const fail = a.includes('/setintegritylevel') && a[0] === uv;
    return { code: fail ? 1 : 0, stdout: '', stderr: fail ? 'The media is write protected.' : '' } as never;
  };
  assert.equal(await labelLow(tg, exec, (l) => void said.push(l), 'acct'), false, said.join('\n'));
  const set = setCalls(calls);
  assert.ok(!set.includes(path.join(d, 'cache')), `cache left Medium: ${JSON.stringify(set)}`);
  assert.ok(set.includes(path.join(d, 'cache', 'nuget')), `cache/nuget holds no failed folder: ${JSON.stringify(set)}`);
  assert.match(said.join('\n'), /left .*cache Medium: .*uv could not be labelled Low/);
});

test('makeSharedLockDirs makes nothing more below a folder swapped for a link as it was made (review w6374)', (t) => {
  const root = tmp(t);
  const made: string[] = [];
  const cache = path.join(root, 'cache');
  makeSharedLockDirs(root, (p) => {
    made.push(p);
    fs.mkdirSync(p);
  }, (p) => made.includes(cache) && p === cache);
  assert.ok(made.includes(cache));
  assert.ok(!made.some((p) => p.startsWith(cache + path.sep)), JSON.stringify(made));
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
  // Windows: the entry is labelled Medium whole, folder by folder and never with /T (review w6355 M1); a failed icacls
  // removes it.
  const calls: string[][] = [];
  const winExec = async (_c: string, a: string[]) => (calls.push(a), { code: 0, stdout: '', stderr: '' });
  put(path.join(d, 'win', 'sub', 'f'));
  assert.equal(await lockIn(path.join(d, 'win'), { ...deps, platform: 'win32', exec: winExec }), true);
  assert.deepEqual(calls[0], [path.join(d, 'win'), '/setintegritylevel', '(OI)(CI)medium']);
  assert.ok(calls.some((a) => a[0] === path.join(d, 'win', 'sub') && a[2] === '(OI)(CI)medium'), JSON.stringify(calls));
  assert.ok(!calls.flat().includes('/T'), JSON.stringify(calls));
  // A link is found before anything is labelled: icacls would label what a junction points at.
  calls.length = 0;
  fs.mkdirSync(path.join(d, 'winj'));
  fs.symlinkSync(path.join(d, 'target'), path.join(d, 'winj', 'l'), 'junction');
  assert.equal(await lockIn(path.join(d, 'winj'), { ...deps, platform: 'win32', exec: winExec }), false);
  assert.deepEqual(calls, [], 'no icacls call at all');
  assert.ok(!fs.existsSync(path.join(d, 'winj')) && fs.existsSync(path.join(d, 'target')));
  assert.equal(await lockIn(path.join(d, 'win'), { ...deps, platform: 'win32', exec: async () => ({ code: 5, stdout: '', stderr: 'Access is denied.' }) }), false);
  assert.ok(!fs.existsSync(path.join(d, 'win')));
});

test('Windows: labelLow walks a locked folder entry by entry, never with /T, and never follows a junction planted in it (review w6355 H1)', { skip: process.platform !== 'win32' && 'junctions are Windows only' }, async (t) => {
  const d = tmp(t);
  const seed = path.join(d, 'cache', 'uv');
  put(path.join(seed, 'a', 'f'));
  const outside = path.join(d, 'secrets');
  put(path.join(outside, 's'));
  fs.symlinkSync(outside, path.join(seed, 'a', 'j'), 'junction');
  for (const on of [false, true]) {
    const calls: string[][] = [];
    const said: string[] = [];
    // Nothing reads Low or Medium of its own: every folder gets labelled.
    const exec: Exec = async (_c, a) => (calls.push(a), { code: 0, stdout: '', stderr: '' }) as never;
    const tg = on ? { dirs: [], files: [], medium: [seed], trees: [seed] } : { dirs: [seed], files: [], trees: [seed] };
    assert.equal(await labelLow(tg, exec, (l) => void said.push(l), 'acct'), true, said.join('\n'));
    const set = calls.filter((a) => a.includes('/setintegritylevel'));
    assert.ok(set.some((a) => a[0] === seed) && set.some((a) => a[0] === path.join(seed, 'a')), `${on}: ${JSON.stringify(set)}`);
    assert.ok(!calls.flat().includes('/T'), `${on}: no /T`);
    assert.ok(!calls.some((a) => a[0].startsWith(outside) || a[0] === path.join(seed, 'a', 'j')), `${on}: the junction and its target untouched: ${JSON.stringify(calls)}`);
    if (!on) assert.match(said.join('\n'), /1 link .*skipped/);
    else {
      // Review w6362: under "on" the link goes (its folder is Medium now, so it stays gone); its target stays.
      assert.match(said.join('\n'), /removed link .*\bj\b/);
      assert.ok(!fs.existsSync(path.join(seed, 'a', 'j')), 'the junction is gone');
      assert.ok(fs.existsSync(path.join(outside, 's')), 'what it led to is kept');
    }
  }
});

test('Windows: labelTree reads a folder again after labelling it and never walks one swapped for a junction meanwhile (review w6362)', { skip: process.platform !== 'win32' && 'junctions are Windows only' }, async (t) => {
  const { labelTree } = await import('./transcriptLabels.ts');
  const d = tmp(t);
  const seed = path.join(d, 'seed');
  put(path.join(seed, 'sub', 'f'));
  const outside = path.join(d, 'outside');
  put(path.join(outside, 'deep', 's'));
  const calls: string[][] = [];
  // The swap happens as the folder is labelled, after it was listed as a plain folder.
  const icacls = (a: string[]) => {
    calls.push(a);
    if (a[0] === path.join(seed, 'sub') && !fs.lstatSync(a[0]).isSymbolicLink()) {
      fs.rmSync(a[0], { recursive: true });
      fs.symlinkSync(outside, a[0], 'junction');
    }
    return { code: 0, out: '' };
  };
  const found: string[] = [];
  assert.equal(await labelTree(seed, 'medium', icacls, 'acct', found), 1);
  assert.deepEqual(found, [path.join(seed, 'sub')]);
  assert.ok(!calls.some((a) => a[0].startsWith(outside) || a[0].startsWith(path.join(seed, 'sub') + path.sep)), JSON.stringify(calls));
  // The root itself, swapped while it is labelled: refused, not walked.
  const root2 = path.join(d, 'seed2');
  put(path.join(root2, 'f'));
  const calls2: string[][] = [];
  const swapRoot = (a: string[]) => {
    calls2.push(a);
    if (a[0] === root2 && !fs.lstatSync(root2).isSymbolicLink()) {
      fs.rmSync(root2, { recursive: true });
      fs.symlinkSync(outside, root2, 'junction');
    }
    return { code: 0, out: '' };
  };
  await assert.rejects(labelTree(root2, 'medium', swapRoot, 'acct'), /turned into a junction/);
  assert.equal(calls2.length, 1, JSON.stringify(calls2));
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
  // A worker's token (LOWRUN): the runner's own token at Low keeps SeBackup and SeRestore, which pass any label (CI run
  // 45959235451: its Low cmd renamed cache\uv under "on").
  const run = lowRunner(path.join(base, 'bin'));
  const low = (line: string) => {
    const r = run(line);
    assert.equal(r.launch, undefined, `the launcher ran: ${line}`);
    return r;
  };
  // Junctions planted before the switch (review w6355 H1): one in a seed to a Low folder, one in cache/slots to a Medium
  // one. Neither target may change label, on or off.
  const outLow = path.join(base, 'outside-low');
  const outMed = path.join(base, 'outside-medium');
  fs.mkdirSync(outLow);
  fs.mkdirSync(outMed);
  assert.equal((await realExec('icacls', [outLow, '/setintegritylevel', '(OI)(CI)low'])).code, 0);
  fs.symlinkSync(outLow, path.join(root, 'cache', 'uv', 'planted'), 'junction');
  fs.mkdirSync(path.join(root, 'cache', 'slots'), { recursive: true });
  fs.symlinkSync(outMed, path.join(root, 'cache', 'slots', 'planted'), 'junction');
  const targetsKept = async (when: string) => {
    const low1 = (await realExec('icacls', [outLow])).stdout;
    assert.ok(isLabelledLow(low1) && !isExplicitMedium(low1), `${when}: the seed junction's target still Low: ${low1}`);
    const med = (await realExec('icacls', [outMed])).stdout;
    assert.ok(!isLabelledLow(med), `${when}: the cache/slots junction's target still Medium: ${med}`);
  };
  await targetsKept('off');
  const uvOld = path.join(root, 'cache', 'uv', 'old.txt');
  assert.equal(low(`echo x> "${uvOld}"`).status, 0, 'off: a Low write into cache/uv');
  assert.ok(fs.existsSync(uvOld), 'the shell really ran the line');

  assert.equal(await labelLow(tg(true), realExec, (l) => void said.push(l)), true, said.join('\n'));
  assert.ok(isExplicitMedium((await realExec('icacls', [path.join(root, 'cache', 'uv')])).stdout));
  await targetsKept('on');
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
    assert.equal(r.status, 0, `on: a Low write into ${p}: ${r.out}`);
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
  await targetsKept('off again');
  for (const line of [`echo y>> "${uvOld}"`, `echo y>> "${path.join(dst, 'f')}"`, `echo x> "${path.join(root, 'players', 'slot1-0', 'player', 'Game.exe')}"`, `echo x> "${path.join(root, 'seed', 'x.txt')}"`, `echo x> "${path.join(root, 'cache', 'new.txt')}"`]) {
    const r = low(line);
    assert.equal(r.status, 0, `off again: ${line}: ${r.out}`);
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

test('live (Linux, review w6362): symlinks planted under off at cache/nuget and among cache\'s children carry no write rule under "on"', { skip: !landlock && 'needs Landlock and python3' }, (t) => {
  const root = tmp(t);
  for (const d of ['cache/uv', 'cache/slots', 'players', 'seed', 'sandboxes', 'tools/git', 'daemon/logs', 'outside']) fs.mkdirSync(path.join(root, ...d.split('/')), { recursive: true });
  const r = (p: string) => path.join(root, ...p.split('/'));
  fs.symlinkSync(r('daemon'), r('cache/nuget'));
  fs.symlinkSync(r('outside'), r('cache/evil'));
  makeSharedLockDirs(root);
  assert.deepEqual(fs.readdirSync(r('daemon')), ['logs'], 'nothing made through the cache/nuget link');
  const script = [
    'try() { if sh -c "$2" 2>/dev/null; then echo "$1 ok"; else echo "$1 refused"; fi; }',
    `try nuget-link "echo x > ${r('cache/nuget/logs/x')}"`,
    `try daemon "echo x > ${r('daemon/logs/x')}"`,
    `try evil-link "echo x > ${r('cache/evil/x')}"`,
    `try outside "echo x > ${r('outside/x')}"`,
    `try slots "echo x > ${r('cache/slots/x')}"`,
  ].join('\n');
  const on = spawnSync('python3', [FF_LANDLOCK, ...writeLockArgs({ root, sharedLock: true, extra: ['/dev/null'] }), '--', 'bash', '-c', script], { encoding: 'utf8' });
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(on.stdout.trim().split('\n'), ['nuget-link refused', 'daemon refused', 'evil-link refused', 'outside refused', 'slots ok']);
});
