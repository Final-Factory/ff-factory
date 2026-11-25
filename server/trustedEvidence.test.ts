import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkoutScript, findPrEvidence, refreshTrustedCheckout, resolveTrusted, trustedAgentsCheckout, trustedEvidenceRun, trustedPathValue } from '../machine/evidenceGate.ts';
import { makeGhEvidence } from './guard.ts';

/**
 * w5542 (w5451 item 4): the guard's Evidence check runs in the agent host, above the worker fence, and picked the newest
 * pr_evidence.py by plugin.json version from the plugin cache, FF_SKILLS and `<root>/tools/final-factory-agents`, all of
 * which a worker can write: a planted "999.0.0" copy would have run at the host's level. Now it runs only its own checkout
 * in the daemon's folder, with a python and gh from a PATH that holds no worker-writable folder.
 */

const PY = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(PY, ['--version']).status === 0;

/** A script that leaves a marker file named `name` in `marks` when it runs, then prints `say` and exits `code`. */
const marking = (marks: string, name: string, say: string, code = 0) =>
  `import pathlib, sys\npathlib.Path(${JSON.stringify(marks)}, ${JSON.stringify(name)}).write_text("ran")\nprint(${JSON.stringify(say)})\nsys.exit(${code})\n`;

function put(file: string, text: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}

const plugin = (dir: string, version: string, script: string) => {
  put(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  put(path.join(dir, 'skills', 'evidence-gate', 'pr_evidence.py'), script);
};

test('w5542: a planted 999 pr_evidence.py in the plugin cache, the tools checkout or FF_SKILLS is never run; the trusted copy is', { skip: !hasPython && `no ${PY}` }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5542-root-'));
  const marks = path.join(root, 'tmp', 'marks');
  fs.mkdirSync(marks, { recursive: true });
  const appDir = path.join(root, 'daemon');
  const co = trustedAgentsCheckout(appDir);
  put(path.join(co, 'plugins', 'ff-agents', '.claude-plugin', 'plugin.json'), '{"version":"1.37.23"}');
  put(checkoutScript(co), marking(marks, 'trusted', 'evidence-gate: PASS (trusted)'));
  // The plants: the newest version in each folder a worker can write.
  const cache = path.join(root, 'claude', 'plugins', 'cache', 'final-factory-agents', 'ff-agents', '999.0.0');
  plugin(cache, '999.0.0', marking(marks, 'planted-cache', 'evidence-gate: PASS (planted)'));
  plugin(path.join(root, 'tools', 'final-factory-agents', 'plugins', 'ff-agents'), '999.0.1', marking(marks, 'planted-tools', 'evidence-gate: PASS (planted)'));
  // A python module on PYTHONPATH that would run at startup, and a pycache prefix, both in the worker's folders.
  put(path.join(root, 'tmp', 'pp', 'sitecustomize.py'), marking(marks, 'planted-sitecustomize', ''));
  const env: Record<string, string> = {
    FF_WORKER_ROOT: root,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    FF_SKILLS: path.join(cache, 'skills'),
    PYTHONPATH: path.join(root, 'tmp', 'pp'),
    PATH: [path.join(root, 'unity-slots', 'bin'), process.env.PATH ?? ''].join(path.delimiter),
  };
  if (process.platform !== 'win32') {
    // A python3 and a gh planted first on the worker's PATH (`<root>/unity-slots/bin` is writable and comes first).
    put(path.join(root, 'unity-slots', 'bin', 'python3'), `#!/bin/sh\necho ran > "${marks}/planted-python"\necho "evidence-gate: PASS (planted python)"\n`, 0o755);
    put(path.join(root, 'unity-slots', 'bin', 'gh'), `#!/bin/sh\necho ran > "${marks}/planted-gh"\n`, 0o755);
  }
  // The guard's findPrEvidence never reads the old <root>/tools checkout (w5597, w5723): it skips that 999.0.1 plant and
  // picks the cache's 999.0.0, still a plant, which is why the merge itself runs only the trusted copy (w5542).
  assert.equal(findPrEvidence({ env, home: root }), path.join(root, 'claude', 'plugins', 'cache', 'final-factory-agents', 'ff-agents', '999.0.0', 'skills', 'evidence-gate', 'pr_evidence.py'));
  const lines: string[] = [];
  const ev = makeGhEvidence({ prUrl: () => 'https://github.com/Final-Factory/FinalFactory/pull/4328', appDir, refresh: () => undefined, log: (l) => lines.push(l) });
  assert.equal(ev('4328', 'Final-Factory/FinalFactory', path.join(root, 'sandboxes', 's1'), env), undefined, 'the trusted copy passed it');
  assert.deepEqual(fs.readdirSync(marks).sort(), ['trusted'], 'only the trusted copy ran');
  assert.match(lines.join('\n'), /evidence check Final-Factory\/FinalFactory#4328: .* -s .*exit 0/);
  assert.doesNotMatch(lines.join('\n'), new RegExp(path.join(root, 'unity-slots').replace(/[\\.]/g, '\\$&')), 'not the planted python');
});

test('w5542: with no trusted copy the merge is refused, even when planted copies are there', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5542-none-'));
  plugin(path.join(root, 'tools', 'final-factory-agents', 'plugins', 'ff-agents'), '999.0.0', 'print("PASS")');
  let ran = 0;
  const ev = makeGhEvidence({ prUrl: () => 'https://github.com/Final-Factory/FinalFactory/pull/1', appDir: path.join(root, 'daemon'), refresh: () => 'git clone: network unreachable', run: () => (ran++, { status: 0, stdout: 'PASS', stderr: '' }), log: () => undefined });
  assert.match(ev('1', undefined, root, { FF_WORKER_ROOT: root }) ?? '', /no pr_evidence\.py found.*the guard's trusted copy: git clone: network unreachable/);
  assert.equal(ran, 0);
  // Another repository is not checked at all.
  assert.equal(makeGhEvidence({ prUrl: () => 'https://github.com/Final-Factory/ff-factory/pull/2', appDir: root, refresh: () => { throw new Error('not asked'); } })('2', undefined, root, {}), undefined);
});

test('w5542: a stale trusted copy is fetched again once and run again; a real FAIL still refuses', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5542-stale-'));
  const appDir = path.join(root, 'daemon');
  put(checkoutScript(trustedAgentsCheckout(appDir)), '');
  const STALE = 'evidence-gate: FAIL\n- this pr_evidence.py is ff-agents 1.37.22, but 1.37.23 is released: update it\n';
  const make = (answers: string[], refreshes: boolean[]) => makeGhEvidence({
    prUrl: () => 'https://github.com/Final-Factory/FinalFactory/pull/9', appDir, log: () => undefined,
    refresh: (_co, force) => (refreshes.push(force), undefined),
    run: () => { const a = answers.shift()!; return { status: a.startsWith('PASS') ? 0 : 1, stdout: a, stderr: '' }; },
  });
  const r1: boolean[] = [];
  assert.equal(make([STALE, 'PASS'], r1)('9', undefined, root, { FF_WORKER_ROOT: root, PATH: process.env.PATH ?? '' }), undefined);
  assert.deepEqual(r1, [false, true], 'a check by age, then one forced fetch');
  const r2: boolean[] = [];
  assert.match(make([STALE, 'evidence-gate: FAIL\n- no \'Not verified:\' line\n'], r2)('9', undefined, root, { FF_WORKER_ROOT: root, PATH: process.env.PATH ?? '' }) ?? '', /no 'Not verified:' line/);
  assert.deepEqual(r2, [false, true]);
});

test('w5542: the trusted PATH drops every folder in the worker root except the daemon\'s, and relative entries', () => {
  assert.equal(trustedPathValue('/home/b/ffw/daemon/gh-app/bin:/home/b/ffw/unity-slots/bin:/usr/bin::.:bin:/home/b/ffw2/bin', '/home/b/ffw', '/home/b/ffw/daemon', path.posix),
    '/home/b/ffw/daemon/gh-app/bin:/usr/bin:/home/b/ffw2/bin');
  assert.equal(trustedPathValue('F:\\ffw\\unity-slots\\bin;C:\\Program Files\\GitHub CLI;f:/FFW/tools/git/cmd;F:\\ffw\\daemon\\gh-app\\bin', 'F:\\ffw', 'F:\\ffw\\daemon', path.win32),
    'C:\\Program Files\\GitHub CLI;F:\\ffw\\daemon\\gh-app\\bin');
  // Windows: a bare name resolves through PATHEXT on the given PATH only, never the working directory.
  const has = new Set(['C:\\Program Files\\GitHub CLI\\gh.exe']);
  assert.equal(resolveTrusted('gh', 'C:\\Program Files\\GitHub CLI', path.win32, (p) => has.has(p)), 'C:\\Program Files\\GitHub CLI\\gh.exe');
  assert.equal(resolveTrusted('gh', '', path.win32, () => true), undefined);
});

test('w5542: the run has no PYTHON* setting, -s, the checkout as cwd, and the sandbox\'s HUD pins by FF_HUD_DATA', () => {
  const root = '/r';
  const files = new Set(['/usr/bin/python3', '/r/sandboxes/s1/scripts/nightly/ui_layout/hud-pins.json']);
  const t = trustedEvidenceRun({
    script: '/r/daemon/trusted/final-factory-agents/plugins/ff-agents/skills/evidence-gate/pr_evidence.py', repo: 'Final-Factory/FinalFactory', pr: 7,
    workerEnv: { FF_WORKER_ROOT: root, PATH: '/r/unity-slots/bin:/usr/bin', PYTHONPATH: '/r/tmp', PYTHONPYCACHEPREFIX: '/r/tmp/pc', PYTHONUTF8: '1', GH_TOKEN: 'x' },
    hostEnv: {}, appDir: '/r/daemon', sandboxDir: '/r/sandboxes/s1/Assets', platform: 'linux', exists: (p) => files.has(p),
  });
  assert.ok(!('error' in t));
  if ('error' in t) return;
  assert.equal(t.python, '/usr/bin/python3');
  assert.deepEqual(t.args.slice(0, 1), ['-s']);
  assert.equal(t.cwd, '/r/daemon/trusted/final-factory-agents/plugins/ff-agents/skills/evidence-gate');
  assert.equal(t.env.PATH, '/usr/bin');
  assert.equal(t.env.PYTHONPATH, undefined);
  assert.equal(t.env.PYTHONPYCACHEPREFIX, undefined);
  assert.equal(t.env.PYTHONUTF8, '1');
  assert.equal(t.env.GH_TOKEN, 'x', "the worker's GitHub token still reaches gh");
  assert.equal(t.env.FF_HUD_DATA, '/r/sandboxes/s1/scripts/nightly/ui_layout');
  // An FF_PYTHON in a worker-writable folder is refused, not run.
  const bad = trustedEvidenceRun({ script: '/s.py', repo: 'a/b', pr: 1, workerEnv: { FF_WORKER_ROOT: root }, hostEnv: { FF_PYTHON: '/r/tools/py/python3' }, appDir: '/r/daemon', platform: 'linux', exists: () => true });
  assert.match('error' in bad ? bad.error : '', /workers can write/);
});

test('w5542: the trusted checkout is cloned aside and renamed into place, fetched when old or forced, kept when a fetch fails', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'w5542-co-'));
  const co = trustedAgentsCheckout(app);
  const calls: string[][] = [];
  let fetchWorks = true;
  let t = 1_000_000;
  const git = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'clone') put(path.join(args.at(-1)!, '.git', 'HEAD'), 'ref');
    return { code: args.includes('fetch') && !fetchWorks ? 128 : 0, stderr: args.includes('fetch') && !fetchWorks ? 'fatal: unable to access' : '' };
  };
  const deps = { git, now: () => t };
  assert.equal(refreshTrustedCheckout(co, deps), undefined);
  assert.equal(calls[0]![0], 'clone');
  assert.notEqual(calls[0]!.at(-1), co, 'cloned into a folder of its own');
  assert.ok(fs.existsSync(path.join(co, '.git', 'HEAD')), 'then renamed into place');
  calls.length = 0;
  // Fresh (the marker's mtime is now; the fake clock is far behind it): no fetch.
  t = Date.now();
  assert.equal(refreshTrustedCheckout(co, deps), undefined);
  assert.deepEqual(calls, []);
  assert.equal(refreshTrustedCheckout(co, deps, { force: true }), undefined);
  assert.deepEqual(calls.map((a) => a[2]), ['fetch', 'reset']);
  calls.length = 0;
  t = Date.now() + 11 * 60_000;
  fetchWorks = false;
  assert.match(refreshTrustedCheckout(co, deps) ?? '', /git fetch .*unable to access/);
  assert.ok(fs.existsSync(path.join(co, '.git', 'HEAD')), 'the copy it had stays');
});
