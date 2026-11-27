import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cacheFolderName, ensureMirror, fileUrlOf, GitPackages, gitDepsOf, gitPackagesModeOf, githubRepoOf, insteadOfEnv, isGitSpec, lowGitPath, mirrorDirOf, missingGitPackages, missingNote, type MirrorGit, type ProjectFs } from './gitPackages.ts';
import { MacUnity, MacUnityWatch, type EditorFence, type Proc, type UnityDeps } from './unity.ts';
import type { RunResult } from '../server/proc.ts';
import { findDialogs, type EditorWindow } from '../server/watchdog.ts';

const KNN = 'https://github.com/Final-Factory/KNN.git#375be6b9ffb09bcc4aee1c97d39743fc9c77c2c3';
const KNN_SHA = '375be6b9ffb09bcc4aee1c97d39743fc9c77c2c3';
const PARREL = 'https://github.com/VeriorPies/ParrelSync.git?path=/ParrelSync#a122dc90cbe2d4cc2669ddad00b12b3917ef934b';

test('w6412: the mode is warn unless daemon.json says off or on', () => {
  assert.equal(gitPackagesModeOf(undefined), 'warn');
  assert.equal(gitPackagesModeOf('yes'), 'warn');
  assert.equal(gitPackagesModeOf('off'), 'off');
  assert.equal(gitPackagesModeOf('on'), 'on');
});

test('w6412: git specs are told from registry versions and file: paths', () => {
  assert.ok(isGitSpec(KNN));
  assert.ok(isGitSpec(PARREL));
  assert.ok(isGitSpec('git+https://example.com/a/b'));
  assert.ok(isGitSpec('git@github.com:a/b.git'));
  assert.ok(!isGitSpec('1.2.3'));
  assert.ok(!isGitSpec('file:../Local/pkg'));
  assert.ok(!isGitSpec('https://example.com/a.tgz'));
});

test('w6412: Library/PackageCache folder names (measured on m5/slot1: with ?path= the sha1 of hash + path, else the hash)', () => {
  assert.equal(cacheFolderName('com.veriorpies.parrelsync', 'a122dc90cbe2d4cc2669ddad00b12b3917ef934b', '/ParrelSync'), 'com.veriorpies.parrelsync@ca2a190a45f6');
  assert.equal(cacheFolderName('com.akb.knn', KNN_SHA), 'com.akb.knn@375be6b9ffb0');
});

test('w6412: the manifest\'s git deps carry the lock\'s commit only when the lock is for the same spec', () => {
  const manifest = JSON.stringify({ dependencies: { 'com.akb.knn': KNN, 'com.unity.x': '1.0.0', 'com.b': 'https://github.com/o/b.git#main', 'com.p': PARREL } });
  const lock = JSON.stringify({ dependencies: { 'com.b': { version: 'https://github.com/o/b.git#main', source: 'git', hash: 'b'.repeat(40) }, 'com.p': { version: 'https://github.com/other.git', source: 'git', hash: 'c'.repeat(40) } } });
  const deps = gitDepsOf(manifest, lock);
  assert.deepEqual(deps.map((d) => d.name), ['com.akb.knn', 'com.b', 'com.p']);
  assert.equal(deps[0].url, 'https://github.com/Final-Factory/KNN.git');
  assert.equal(deps[0].lockHash, KNN_SHA, 'a full commit as the revision is the commit');
  assert.equal(deps[1].lockHash, 'b'.repeat(40));
  assert.equal(deps[2].subPath, '/ParrelSync');
  assert.equal(deps[2].lockHash, 'a122dc90cbe2d4cc2669ddad00b12b3917ef934b', 'a lock entry for another spec is not used');
  assert.deepEqual(gitDepsOf('not json'), []);
});

function projectFs(files: Record<string, string>, cache: string[]): ProjectFs {
  return {
    readFile: (p) => {
      const k = p.replace(/\\/g, '/');
      if (!(k in files)) throw new Error('ENOENT');
      return files[k];
    },
    readdir: (p) => {
      if (!p.replace(/\\/g, '/').endsWith('Library/PackageCache')) throw new Error('ENOENT');
      return cache;
    },
    exists: (p) => p.replace(/\\/g, '/') in files,
  };
}

test('w6412: a git package is missing when its exact cache folder is not there; an embedded copy is never missing', () => {
  const manifest = JSON.stringify({ dependencies: { 'com.akb.knn': KNN, 'com.p': PARREL, 'com.e': 'https://github.com/o/e.git', 'com.f': 'https://github.com/o/f.git' } });
  const files = { 'R:/sb/Packages/manifest.json': manifest, 'R:/sb/Packages/com.e/package.json': '{}' };
  const none = missingGitPackages('R:/sb', projectFs(files, []), 'win32');
  assert.deepEqual(none.map((d) => d.name), ['com.akb.knn', 'com.p', 'com.f']);
  const some = missingGitPackages('R:/sb', projectFs(files, ['com.akb.knn@375be6b9ffb0', 'com.p@a122dc90cbe2', 'com.f@0123456789ab']), 'win32');
  assert.deepEqual(some.map((d) => d.name), ['com.p'], 'com.p\'s folder is the sha1 of hash + path, not the hash');
  assert.deepEqual(missingGitPackages('R:/none', projectFs({}, []), 'win32'), [], 'no manifest: nothing');
});

test('w6412: only github.com https URLs get a mirror, under <root>/cache-medium/git-packages', () => {
  assert.deepEqual(githubRepoOf('https://github.com/Final-Factory/KNN.git'), { owner: 'Final-Factory', repo: 'KNN' });
  assert.equal(githubRepoOf('git@github.com:a/b.git'), undefined);
  assert.equal(githubRepoOf('https://gitlab.com/a/b.git'), undefined);
  assert.equal(mirrorDirOf('/ffw', 'https://github.com/Final-Factory/KNN.git'), path.join('/ffw', 'cache-medium', 'git-packages', 'github.com', 'Final-Factory', 'KNN.git'));
  assert.equal(fileUrlOf(String.raw`F:\ffw\cache-medium\git-packages\github.com\o\r.git`), 'file:///F:/ffw/cache-medium/git-packages/github.com/o/r.git');
  assert.equal(fileUrlOf('/ffw/m/r.git'), 'file:///ffw/m/r.git');
});

test('w6412: insteadOf entries go after the ones already set; the workers\' Git goes first on PATH', () => {
  const env = insteadOfEnv([{ url: 'https://github.com/o/r.git', dir: String.raw`F:\ffw\m\r.git` }], { GIT_CONFIG_COUNT: '2' });
  assert.deepEqual(env, { GIT_CONFIG_KEY_2: 'url.file:///F:/ffw/m/r.git.insteadOf', GIT_CONFIG_VALUE_2: 'https://github.com/o/r.git', GIT_CONFIG_COUNT: '3' });
  assert.deepEqual(insteadOfEnv([], {}), {});
  assert.equal(lowGitPath(String.raw`F:\ffw\tools\git`, String.raw`C:\Windows`), String.raw`F:\ffw\tools\git\cmd;F:\ffw\tools\git\usr\bin;C:\Windows`);
});

test('w6412: the note names the package, the Low cause and the route; off says nothing', () => {
  const [dep] = gitDepsOf(JSON.stringify({ dependencies: { 'com.akb.knn': KNN } }));
  const warn = missingNote([dep], 'warn', true)!;
  assert.match(warn, /com\.akb\.knn \(https:\/\/github\.com\/Final-Factory\/KNN\.git#375be6b9ffb0\)/);
  assert.match(warn, /Low-integrity/);
  assert.match(warn, /editor_git_packages on/);
  assert.match(warn, /Packages\/<name>/);
  assert.doesNotMatch(missingNote([dep], 'warn', false)!, /Low-integrity/, 'a Medium editor fetches it itself');
  assert.equal(missingNote([dep], 'off', true), undefined);
  assert.equal(missingNote([], 'warn', true), undefined);
});

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' }) as RunResult;
const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr }) as RunResult;

test('w6412: ensureMirror makes a bare mirror, fetches it and pins the locked commit; a commit already there fetches nothing', async () => {
  const [dep] = gitDepsOf(JSON.stringify({ dependencies: { 'com.akb.knn': KNN } }));
  const calls: string[][] = [];
  let haveIt = false;
  const git: MirrorGit = async (args) => {
    calls.push(args);
    if (args.includes('cat-file')) return haveIt ? ok() : fail('missing');
    if (args.includes('fetch')) haveIt = true;
    if (args.includes('ls-remote')) return ok('ref: refs/heads/main\tHEAD\n');
    return ok();
  };
  const made: string[] = [];
  const r = await ensureMirror('/ffw', dep, git, { exists: () => false, mkdir: (p) => void made.push(p) });
  assert.ok('dir' in r);
  const dir = mirrorDirOf('/ffw', dep.url)!;
  assert.deepEqual(made, [dir]);
  const verbs = calls.map((c) => c.filter((a) => !a.startsWith('--git-dir'))[0]);
  assert.deepEqual(verbs, ['init', 'config', 'config', 'config', 'cat-file', 'fetch', 'ls-remote', 'symbolic-ref', 'cat-file', 'update-ref']);
  assert.ok(calls.some((c) => c.join(' ').includes(`update-ref refs/ff-pin/${KNN_SHA} ${KNN_SHA}`)));

  calls.length = 0;
  await ensureMirror('/ffw', dep, git, { exists: () => true, mkdir: () => undefined });
  assert.ok(!calls.some((c) => c.includes('fetch')), 'already there: no fetch');
});

test('w6412: ensureMirror says why when the fetch fails, and refuses a URL its credential does not cover', async () => {
  const [dep] = gitDepsOf(JSON.stringify({ dependencies: { 'com.akb.knn': KNN } }));
  const git: MirrorGit = async (args) => (args.includes('fetch') ? fail('fatal: could not read Username') : args.includes('cat-file') ? fail('') : ok());
  const r = await ensureMirror('/ffw', dep, git, { exists: () => true, mkdir: () => undefined });
  assert.ok('why' in r && /could not read Username/.test(r.why));
  const [gl] = gitDepsOf(JSON.stringify({ dependencies: { x: 'https://gitlab.com/a/b.git' } }));
  const r2 = await ensureMirror('/ffw', gl, git);
  assert.ok('why' in r2 && /not a github\.com/.test(r2.why));
});

const REPO = String.raw`V:\ffw\sandboxes\slot2`;
const BIN = String.raw`C:\Program Files\Unity\Hub\Editor\6000.3.19f1\Editor\Unity.exe`;
const JUNCTION_BIN = String.raw`V:\ffw\tools\unity-low\6000.3.19f1\Unity.exe`;
const FENCE: EditorFence = { launcher: String.raw`V:\ffw\tools\low\node.exe`, unityDir: String.raw`V:\ffw\tools\unity-low`, licensingIpc: 'LicenseClient-u-low', env: { APPDATA: String.raw`V:\ffw\home\AppData\Roaming` }, gitDir: String.raw`V:\ffw\tools\git` };

function winEditor(mode: 'off' | 'warn' | 'on', fetchFails = false) {
  const world = { procs: [] as Proc[], low: [] as { env?: Record<string, string> }[], now: 0, gitCalls: [] as string[][] };
  const deps: UnityDeps = {
    procs: async () => [...world.procs],
    kill: () => undefined,
    launch: () => 1,
    launchFenced: async (_f, bin, args, _cwd, env) => {
      world.low.push({ env });
      const pid = 7000 + world.procs.length;
      world.procs.push({ pid, ppid: 1, cmd: `"${bin}" ${args.join(' ')}` });
      return pid;
    },
    exists: (p) => p === JUNCTION_BIN,
    remove: () => undefined,
    sleep: async (ms) => void (world.now += ms),
    now: () => world.now,
  };
  let have = false;
  const gp = new GitPackages({
    mode: () => mode,
    root: String.raw`V:\ffw`,
    platform: 'win32',
    fs: projectFs({ 'V:/ffw/sandboxes/slot2/Packages/manifest.json': JSON.stringify({ dependencies: { 'com.akb.knn': KNN } }) }, []),
    exists: () => false,
    mkdir: () => undefined,
    git: async (args) => {
      world.gitCalls.push(args);
      if (args.includes('cat-file')) return have ? ok() : fail('');
      if (args.includes('fetch')) {
        if (fetchFails) return fail('fatal: Authentication failed');
        have = true;
      }
      return ok();
    },
  });
  const u = new MacUnity(REPO, deps, () => BIN, 'win32', {}, { fence: () => FENCE, gitPackages: gp });
  return { world, u, gp };
}

test('w6412: warn (the default) starts the Low editor as before and names the missing package, the cause and the route', async () => {
  const { world, u } = winEditor('warn');
  const said = await u.start();
  assert.equal(world.gitCalls.length, 0, 'warn fetches nothing');
  assert.equal(world.low[0].env?.GIT_CONFIG_COUNT, undefined);
  assert.match(said, /missing from Library\/PackageCache: com\.akb\.knn.*Low-integrity.*editor_git_packages on/);
  assert.match(await u.status(), /com\.akb\.knn/);
});

test('w6412: on mirrors the package and starts the Low editor with the workers\' Git first and an insteadOf to the mirror', async () => {
  const { world, u } = winEditor('on');
  const said = await u.start();
  const env = world.low[0].env!;
  const mirror = mirrorDirOf(String.raw`V:\ffw`, 'https://github.com/Final-Factory/KNN.git')!;
  assert.equal(env[`GIT_CONFIG_VALUE_${Number(env.GIT_CONFIG_COUNT) - 1}`], 'https://github.com/Final-Factory/KNN.git');
  assert.equal(env[`GIT_CONFIG_KEY_${Number(env.GIT_CONFIG_COUNT) - 1}`], `url.${fileUrlOf(mirror)}.insteadOf`);
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')!;
  assert.ok(env[pathKey].startsWith(String.raw`V:\ffw\tools\git\cmd;V:\ffw\tools\git\usr\bin`));
  assert.match(said, /fetches it from the daemon's mirror/);
  assert.ok(!JSON.stringify(env).match(/token|password/i), 'no credential reaches the editor');
});

test('w6412: on, a mirror that cannot be fetched still starts the editor and says so; off looks at nothing', async () => {
  const a = winEditor('on', true);
  const said = await a.u.start();
  assert.equal(a.world.low.length, 1);
  assert.equal(a.world.low[0].env?.GIT_CONFIG_COUNT, undefined);
  assert.match(said, /could not mirror com\.akb\.knn.*Authentication failed/);

  const b = winEditor('off');
  const saidB = await b.u.start();
  assert.doesNotMatch(saidB, /git package/);
  assert.doesNotMatch(await b.u.status(), /git package/);
  assert.equal(b.world.gitCalls.length, 0);
});

test('w6412: after a switch, warn names the package; on begins the mirror for the next start', async () => {
  const w = winEditor('warn');
  assert.match(w.gp.afterSwitch(REPO, true)!, /Low-integrity/);
  const o = winEditor('on');
  assert.match(o.gp.afterSwitch(REPO, true)!, /mirroring it for the editor's next start/);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(o.world.gitCalls.some((c) => c.includes('fetch')));
  assert.equal(winEditor('off').gp.afterSwitch(REPO, true), undefined);
});

test('w6412: the Package Manager dialog notice names the missing git package, the cause and the route', async () => {
  const { world, u } = winEditor('warn');
  world.procs.push({ pid: 100, ppid: 1, cmd: `"${JUNCTION_BIN}" -projectPath ${REPO}` });
  const reports: string[] = [];
  const now = Date.parse('2026-11-27T12:00:00Z');
  const w = new MacUnityWatch(u, (t) => void reports.push(t), {
    logStat: () => ({ size: 1, mtimeMs: now }),
    logTail: () => '',
    bridge: () => ({}),
    ping: async () => false,
    now: () => now,
    listDialogs: async (pid) => ({ dialogs: findDialogs([{ hwnd: 9, pid, class: '#32770', enabled: true, owned: true, title: 'Unity Package Manager Error', text: ['An error occurred while resolving packages: com.akb.knn'], buttons: ['Retry', 'Quit', 'Continue'] } as EditorWindow]), mainTitle: 'slot2' }),
    pressButton: async () => false,
    sceneFilesClean: async () => true,
    nodePath: () => 'node',
    sessionState: async () => ({}),
    axTrusted: async () => true,
    tccEntry: async () => undefined,
    axPrompt: async () => undefined,
  });
  await w.tick();
  const said = reports.find((r) => /Package Manager Error/.test(r));
  assert.ok(said, reports.join('\n'));
  assert.match(said, /missing from Library\/PackageCache: com\.akb\.knn.*Low-integrity.*editor_git_packages on/);
  assert.match(said, /Read the log first/, 'the rule\'s own advice stays');
});

// A real UPM-shaped fetch through the mirror: `git fetch --depth=1 origin <sha>` in a fresh repo whose origin is the GitHub
// URL, sent to the mirror by the same GIT_CONFIG_* entries the editor gets (the measured Unity route, with no network).
test('w6412: a shallow fetch of a pinned commit by the manifest URL reads the mirror (real git)', async () => {
  if (spawnSync('git', ['--version']).status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w6412-'));
  try {
    const g = (cwd: string, ...a: string[]) => {
      const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const up = path.join(tmp, 'up');
    fs.mkdirSync(up);
    g(up, 'init', '-q');
    fs.writeFileSync(path.join(up, 'package.json'), '{"name":"com.t"}');
    g(up, 'add', '.');
    g(up, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one');
    const sha = g(up, 'rev-parse', 'HEAD');
    const mirror = path.join(tmp, 'm.git');
    g(tmp, 'init', '-q', '--bare', mirror);
    g(tmp, '--git-dir', mirror, 'fetch', '-q', up, sha);
    g(tmp, '--git-dir', mirror, 'update-ref', `refs/ff-pin/${sha}`, sha);
    const url = 'https://github.com/o/never-fetched.git';
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...insteadOfEnv([{ url, dir: mirror }], {}) };
    const work = path.join(tmp, 'w');
    fs.mkdirSync(work);
    const run = (...a: string[]) => spawnSync('git', a, { cwd: work, encoding: 'utf8', env });
    assert.equal(run('init', '-q').status, 0);
    assert.equal(run('remote', 'add', 'origin', url).status, 0);
    const f = run('fetch', '-q', '--depth=1', 'origin', sha);
    assert.equal(f.status, 0, f.stderr);
    assert.equal(run('rev-parse', 'FETCH_HEAD').stdout.trim(), sha);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
