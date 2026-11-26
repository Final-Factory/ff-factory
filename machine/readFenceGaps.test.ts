// w5957: the read fence's three `on`-mode gaps from w5617's re-review of #1193. N5: a given-back file rewritten by rename
// lost its give-back. N6: unity-slot run could not read the person-play hold (<root>/daemon/bench.queue/person.json). N7:
// Windows had no probe before `on` enforced (machine/readFenceWin.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAEMON_READ_ALLOW, FENCE_FILE_WRITERS, FENCE_READ_ALLOW, fenceRootReadBack } from '../server/daemonReads.ts';
import { generationPath, readJsonDurable, writeFileDurable, writeJsonDurable } from '../server/durable.ts';
import { appendCleanupLog } from '../server/cleanup.ts';
import { removePrivileges } from '../server/winPrivileges.fixtures.ts';
import { seatbeltProfile, type WorkerFence } from '../server/workerFence.ts';
import { readLockArgs } from './writeLock.ts';
import { ensureReadBackDirs, readFenceProbeTargets } from './readFence.ts';
import { NO_READ_UP, READ_BACK, noReadUpTargets, relabelInside, relabelScript, type LabelTarget } from './lowIntegrity.ts';
import { buildMirror, mirrorPath, precheckPlan, probeReadFenceWin, realVerdict, windowsReadVerdict } from './readFenceWin.ts';
import { personFile } from './personPlay.ts';

const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `w5957-${n}-`));
const ino = (p: string) => fs.statSync(p, { bigint: true }).ino;
const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '..', f), 'utf8');

// ------------------------------------------------------------------------------------------------ N5

test('w5957 N5: every file the fences give back in the daemon folder names how it is written, and none is written by rename', () => {
  const files = FENCE_READ_ALLOW.filter((p) => /\.[a-z0-9]+$/i.test(p));
  assert.deepEqual(files.filter((f) => !FENCE_FILE_WRITERS[f]), [], 'a given-back file with no writer listed in FENCE_FILE_WRITERS');
  assert.deepEqual(Object.keys(FENCE_FILE_WRITERS).filter((f) => !files.includes(f)), [], 'FENCE_FILE_WRITERS names a file that is not given back');
  // update/job.json and result.json are written by rename (machine/selfUpdate.ts writeJson): their folder is given back.
  assert.ok(!FENCE_READ_ALLOW.some((p) => p.startsWith('update/')) && FENCE_READ_ALLOW.includes('update'));
  assert.ok(DAEMON_READ_ALLOW.includes('update/job.json'), "the guard's list keeps naming the two files (not the bundles)");
  // The writers named for the durable files really pass inPlace, and the clean-up log's roll no longer renames.
  assert.match(src('machine/sandboxes.ts'), /writeJsonDurable\(this\.o\.stateFile, [^\n]*inPlace: true/);
  assert.match(src('machine/pause.ts'), /writeFileDurable\(this\.d\.file, [^\n]*inPlace: true/);
  const roll = src('server/cleanup.ts');
  const fn = roll.slice(roll.indexOf('export function appendCleanupLog'), roll.indexOf('export function appendCleanupLog') + 800);
  assert.ok(!/renameSync/.test(fn.slice(0, fn.indexOf('\n}\n'))), 'appendCleanupLog renames');
});

test('w5957 N5: an inPlace durable write keeps the file (inode), keeps the previous version apart, and heals a torn write', () => {
  const d = tmp('durable');
  try {
    const f = path.join(d, 'sandboxes.json');
    writeJsonDurable(f, [1], { indent: 2 });
    // Written the old way: .1 may be a hard link of the file; the first inPlace write must copy it apart.
    writeJsonDurable(f, [2], { indent: 2 });
    const before = ino(f);
    writeJsonDurable(f, [3], { indent: 2, inPlace: true });
    writeJsonDurable(f, [4, 4, 4, 4], { indent: 2, inPlace: true });
    writeJsonDurable(f, [5], { indent: 2, inPlace: true });
    assert.equal(ino(f), before, 'the same file');
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), [5], 'cut to the new length');
    assert.deepEqual(JSON.parse(fs.readFileSync(generationPath(f, 1), 'utf8')), [4, 4, 4, 4], '.1 is the previous version');
    for (let k = 1; k <= 3; k++) if (fs.existsSync(generationPath(f, k))) assert.notEqual(ino(generationPath(f, k)), before, `.${k} is not a link of the file`);
    // A crash mid-write: the file torn, .1 whole. The load takes .1 and writes it back over the same file.
    fs.writeFileSync(f, '[5, 6', { flag: 'r+' });
    fs.truncateSync(f, 5);
    assert.deepEqual(readJsonDurable(f, { inPlace: true }), [4, 4, 4, 4]);
    // pause.json the same way (machine/pause.ts), from no file at all.
    const p = path.join(d, 'pause.json');
    writeFileDurable(p, '{"v":2}\n', { inPlace: true });
    const pi = ino(p);
    writeFileDurable(p, '{"v":3}\n', { inPlace: true });
    assert.equal(ino(p), pi);
    assert.equal(fs.readFileSync(p, 'utf8'), '{"v":3}\n');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('w5957 N5: the clean-up log rolls to .1 and keeps the file itself', () => {
  const d = tmp('cleanlog');
  try {
    const f = path.join(d, 'cleanup-log.jsonl');
    appendCleanupLog(d, { a: 1 });
    const before = ino(f);
    fs.appendFileSync(f, 'x'.repeat(5 * 1024 * 1024 + 10) + '\n');
    appendCleanupLog(d, { b: 2 });
    assert.equal(ino(f), before, 'the same file after the roll');
    assert.equal(fs.readFileSync(f, 'utf8'), '{"b":2}\n');
    assert.ok(fs.statSync(`${f}.1`).size > 5 * 1024 * 1024, 'the old log is in .1');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ N6

test('w5957 N6: the bench queue (the person-play hold) is given back on all three fences and in the probe', () => {
  const root = path.resolve('/r');
  const queue = path.dirname(personFile(root));
  assert.deepEqual(fenceRootReadBack(root), [queue], 'personPlay.ts personFile sits in the given-back folder');
  // Linux: Landlock --read after the --no-read of <root>/daemon.
  const a = readLockArgs({ root, appDir: path.resolve('/opt/ffd') });
  const of = (flag: string) => a.flatMap((x, i) => (a[i - 1] === flag ? [x] : []));
  assert.ok(of('--no-read').includes(path.join(root, 'daemon')) && of('--read').includes(queue));
  // macOS: the Seatbelt allow, after the deny of <root>/daemon.
  const F: WorkerFence = { kind: 'seatbelt', root: '/Users/p/ffw', home: '/Users/p', darwinTemp: '/private/var/folders/xx/T', darwinCache: '/private/var/folders/xx/C' };
  const p = seatbeltProfile({ ...F, appDir: '/Users/p/.ff-factory' });
  const allow = p.indexOf('(allow file-read-data');
  assert.ok(p.slice(p.indexOf('(deny file-read-data'), allow).includes('(subpath "/Users/p/ffw/daemon")'));
  assert.ok(p.slice(allow).includes('(subpath "/Users/p/ffw/daemon/bench.queue")'));
  // Windows: its own read-back label inside the closed <root>\daemon (LothDesktop: V:\ffw\daemon, beside D:\work\ffw\daemon).
  const R = 'V:\\ffw';
  const app = 'D:\\work\\ffw\\daemon';
  const there = new Set([R + '\\daemon', R + '\\daemon\\bench.queue', app]);
  const t = noReadUpTargets({ root: R, appDir: app, allowBack: [], extraBack: fenceRootReadBack(R, path.win32.join), stat: (x) => (there.has(x) ? 'dir' : undefined), path: path.win32 });
  assert.deepEqual(t.find((x) => x.path === R + '\\daemon'), { path: R + '\\daemon', sddl: NO_READ_UP.dir });
  assert.deepEqual(t.find((x) => x.path === R + '\\daemon\\bench.queue'), { path: R + '\\daemon\\bench.queue', sddl: READ_BACK.dir });
  // The probe opens it as a given-back path.
  const pt = readFenceProbeTargets({ root, appDir: path.join(root, 'daemon'), secrets: [], allowBack: [], rootBack: [queue], exists: () => true, linux: false });
  assert.ok(pt.open.includes(queue));
});

test('w5957 N6: the bench queue folder is made before the fences are set (Landlock skips a missing path)', () => {
  const root = tmp('root');
  try {
    ensureReadBackDirs(path.join(root, 'app'), root);
    assert.ok(fs.statSync(path.join(root, 'daemon', 'bench.queue')).isDirectory());
    assert.ok(fs.statSync(path.join(root, 'app', 'update')).isDirectory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ N7

test('w5957 N7: the warn mirror names each real path under the scratch folder, same kinds, labels on would skip left out', () => {
  assert.equal(mirrorPath('D:\\d\\m', 'V:\\ffw\\secrets'), 'D:\\d\\m\\V\\ffw\\secrets');
  assert.equal(mirrorPath('D:\\d\\m', '\\\\srv\\share\\x'), 'D:\\d\\m\\unc\\srv\\share\\x');
  const labels: LabelTarget[] = [
    { path: 'D:\\w\\daemon', sddl: NO_READ_UP.dir },
    { path: 'D:\\w\\daemon\\logs', sddl: READ_BACK.dir },
    { path: 'V:\\ffw\\root.json', sddl: NO_READ_UP.file },
    { path: 'C:\\Users\\u\\x', sddl: NO_READ_UP.dir },
  ];
  const t = { closed: ['V:\\ffw\\root.json', 'D:\\w\\daemon\\daemon.json'], open: ['D:\\w\\daemon\\logs', 'D:\\w\\daemon\\sandboxes.json'] };
  const kind = (p: string) => (/\.json$/.test(p) ? 'file' : 'dir') as 'dir' | 'file';
  const plan = precheckPlan({ dir: 'E:\\m', labels, t, kind, skip: (p) => p.startsWith('C:') });
  assert.deepEqual(plan.labels.map((x) => x.path), ['E:\\m\\D\\w\\daemon', 'E:\\m\\D\\w\\daemon\\logs', 'E:\\m\\V\\ffw\\root.json'], 'the system drive is not labelled, as on');
  assert.deepEqual(plan.t.open, ['E:\\m\\D\\w\\daemon\\logs', 'E:\\m\\D\\w\\daemon\\sandboxes.json']);
  assert.equal(plan.make[0].path, 'E:\\m\\D\\w\\daemon', 'folders first');
  assert.deepEqual(plan.make.find((m) => m.path.endsWith('sandboxes.json'))?.kind, 'file');
  assert.equal(plan.real.get('E:\\m\\V\\ffw\\root.json'), 'V:\\ffw\\root.json');
  const v = realVerdict({ wronglyRefused: ['E:\\m\\D\\w\\daemon\\logs'], leftOpen: [], unknown: ['E:\\m\\V\\ffw\\root.json (EBUSY)'] }, plan.real);
  assert.deepEqual(v, { wronglyRefused: ['D:\\w\\daemon\\logs'], leftOpen: [], unknown: ['V:\\ffw\\root.json (EBUSY)'] });
});

test('w5957 N7: a lockout verdict takes the labels off in on, and only in on; any failure keeps runs waiting', () => {
  const none = { wronglyRefused: [], leftOpen: [], unknown: [] };
  assert.deepEqual(windowsReadVerdict('on', none), { blocks: false, revert: false });
  assert.deepEqual(windowsReadVerdict('on', { ...none, wronglyRefused: ['x'] }), { blocks: true, revert: true });
  assert.deepEqual(windowsReadVerdict('on', { ...none, unknown: ['x (no answer)'] }), { blocks: true, revert: true });
  assert.deepEqual(windowsReadVerdict('on', { ...none, leftOpen: ['x'] }), { blocks: true, revert: false }, 'a path left open is no lockout');
  assert.deepEqual(windowsReadVerdict('warn', { ...none, wronglyRefused: ['x'] }), { blocks: true, revert: false });
});

/** A fake Low child: refuses what `refuse` says, answers ok for the rest. */
const fakeRun = (refuse: (p: string) => boolean, seen: string[][]) => async (_cmd: string, args: string[]) => {
  const paths = args.slice(2);
  seen.push(paths);
  return { code: 0, stdout: paths.map((p, i) => `${i} ${refuse(p) ? 'refused' : 'ok'}`).join('\n'), stderr: '' };
};

// Real temp paths go through mirrorPath's win32 join, so this runs on Windows only (w5968).
test('w5957 N7: warn builds the mirror (no content copied), labels it, probes it from a Low child, logs the line and removes it', { skip: process.platform !== 'win32' ? 'mirror paths are Windows paths' : false }, async () => {
  const d = tmp('mirror');
  try {
    const real = path.join(d, 'real');
    fs.mkdirSync(path.join(real, 'daemon', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(real, 'daemon', 'daemon.json'), 'SECRET-LIKE');
    const mirrorDir = path.join(d, 'mirror');
    const labels: LabelTarget[] = [{ path: path.join(real, 'daemon'), sddl: NO_READ_UP.dir }, { path: path.join(real, 'daemon', 'logs'), sddl: READ_BACK.dir }];
    const t = { closed: [path.join(real, 'daemon', 'daemon.json')], open: [path.join(real, 'daemon', 'logs')] };
    const seen: string[][] = [];
    const lines: string[] = [];
    let labelled: LabelTarget[] = [];
    let sizes: number[] = [];
    const w = await probeReadFenceWin({
      mode: 'warn', labels, t, lowNode: path.join(d, 'node-low.exe'), mirrorDir, skip: () => false,
      run: async (cmd, args) => {
        sizes = args.slice(2).filter((p) => fs.statSync(p).isFile()).map((p) => fs.statSync(p).size);
        return fakeRun((p) => p.endsWith('daemon.json'), seen)(cmd, args);
      },
      setLabels: async (l) => ((labelled = [...l]), true),
      openLabels: async () => assert.fail('warn never takes labels off the real paths'),
      log: (l) => void lines.push(l),
    });
    assert.ok(seen[0].every((p) => p.startsWith(mirrorDir)), 'only the mirror is opened in warn');
    assert.ok(labelled.every((x) => x.path.startsWith(mirrorDir)) && labelled.length === 2, 'labels only on the mirror');
    assert.deepEqual(sizes, [0], 'the mirror holds empty files, no content');
    assert.equal(w.blocks, false);
    assert.match(lines.at(-1)!, /^read fence \(warn, win32\) probe \(on a mirror .*\): 1\/1 closed paths refused, 1\/1 given-back paths open; no failures$/);
    assert.ok(!fs.existsSync(mirrorDir), 'the mirror is removed');
    // A path workers need refused in the mirror: said by its real name, and runs wait.
    const w2 = await probeReadFenceWin({ mode: 'warn', labels, t, lowNode: 'n', mirrorDir, skip: () => false, run: fakeRun(() => true, []), setLabels: async () => true, openLabels: async () => true, log: (l) => void lines.push(l) });
    assert.equal(w2.blocks, true);
    assert.ok(lines.at(-1)!.includes(`would refuse what workers need: ${path.join(real, 'daemon', 'logs')}`));
    // No Low node: no verdict, runs wait.
    const w3 = await probeReadFenceWin({ mode: 'warn', labels, t, mirrorDir, skip: () => false, run: fakeRun(() => false, []), setLabels: async () => true, openLabels: async () => true, log: (l) => void lines.push(l) });
    assert.equal(w3.blocks, true);
    assert.match(lines.at(-1)!, /not run: no Low node copy/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('w5957 N7: on probes the real paths and, on a lockout, takes the labels off by itself', async () => {
  const labels: LabelTarget[] = [{ path: 'D:\\w\\daemon', sddl: NO_READ_UP.dir }];
  const t = { closed: ['D:\\w\\daemon\\daemon.json'], open: ['D:\\w\\daemon\\logs'] };
  const lines: string[] = [];
  let opened: readonly LabelTarget[] | undefined;
  const base = { mode: 'on' as const, labels, t, lowNode: 'n', mirrorDir: 'E:\\m', skip: () => false, setLabels: async () => assert.fail('on never labels a mirror'), log: (l: string) => void lines.push(l) };
  const ok = await probeReadFenceWin({ ...base, run: fakeRun((p) => p.endsWith('daemon.json'), []), openLabels: async (l) => ((opened = l), true) });
  assert.deepEqual([ok.blocks, ok.reverted, opened], [false, false, undefined]);
  assert.equal(ok.line, 'read fence (on, win32) probe: 1/1 closed paths refused, 1/1 given-back paths open; no failures');
  const bad = await probeReadFenceWin({ ...base, run: fakeRun(() => true, []), openLabels: async (l) => ((opened = l), true) });
  assert.deepEqual([bad.blocks, bad.reverted, opened], [true, true, labels]);
  assert.match(lines.at(-1)!, /labels are off again/);
  const crashed = await probeReadFenceWin({ ...base, run: async () => ({ code: 1, stdout: '', stderr: 'boom' }), openLabels: async () => true });
  assert.deepEqual([crashed.blocks, crashed.reverted], [true, true], 'a probe that could not run counts as a lockout in on');
});

test('w5968: relabelInside walks only the closed folders off the system drive, skips read-backs, and fails on any path it could not set', async () => {
  const t: LabelTarget[] = [
    { path: 'D:\\w\\daemon', sddl: NO_READ_UP.dir },
    { path: 'C:\\anchor\\secrets', sddl: NO_READ_UP.dir },
    { path: 'D:\\w\\root.json', sddl: NO_READ_UP.file },
    { path: 'D:\\w\\daemon\\logs', sddl: READ_BACK.dir },
    { path: 'D:\\w\\daemon\\sandboxes.json', sddl: READ_BACK.file },
  ];
  const sys = (p: string) => p.startsWith('C:');
  // The script: the walk's arguments in PowerShell, and no `$` in the C# (it sits in an expanding here-string).
  const s = relabelScript(['D:\\w\\daemon'], ['D:\\w\\daemon\\logs'], t.map((x) => x.path), true);
  assert.ok(s.endsWith("[FfWalk]::Run([string[]]@('D:\\w\\daemon'), [string[]]@('D:\\w\\daemon\\logs'), [string[]]@('D:\\w\\daemon', 'C:\\anchor\\secrets', 'D:\\w\\root.json', 'D:\\w\\daemon\\logs', 'D:\\w\\daemon\\sandboxes.json'), $true, '', '')"), s.slice(-300));
  const cs = s.slice(s.indexOf('@"') + 2, s.indexOf('"@'));
  assert.ok(!cs.includes('$') && !cs.includes('`'), 'nothing in the C# that PowerShell would expand');
  assert.ok(!/^"@/m.test(cs.slice(1)), 'nothing that ends the here-string early');
  const said: string[] = [];
  let script = '';
  const fake = (stdout: string) => async (_c: string, args: string[]) => ((script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')), { code: 0, stdout, stderr: '' });
  assert.equal(await relabelInside(t, 'close', fake('set D:\\w\\daemon\\x.json\r\ndone 9 1 0\r\n'), (l) => void said.push(l), { systemDrive: sys }), true);
  assert.ok(script.includes("Run([string[]]@('D:\\w\\daemon'), [string[]]@('D:\\w\\daemon\\logs'),"), 'roots: the closed folders off the system drive; skipped: the read-back folders');
  assert.match(said.at(-1)!, /No-Read-Up added to 1 explicitly labelled path\(s\) inside the closed folders \(9 looked at\)/);
  assert.equal(await relabelInside(t, 'open', fake('err 5 D:\\w\\daemon\\y.json\r\ndone 9 0 1\r\n'), (l) => void said.push(l), { systemDrive: sys }), false);
  assert.ok(script.endsWith("$false, '', '')"), 'open never takes a stop file (w6120)');
  assert.ok(said.some((l) => l.includes('err 5 D:\\w\\daemon\\y.json')));
  // No answer from PowerShell: not done.
  assert.equal(await relabelInside(t, 'close', fake(''), (l) => void said.push(l), { systemDrive: sys }), false);
  // Nothing closed off the system drive: nothing to walk.
  assert.equal(await relabelInside(t, 'close', async () => assert.fail('no walk'), () => {}, { systemDrive: () => true }), true);
});

/** Whether this process runs at Low integrity (whoami /groups names the label). */
const lowSelf = () => /S-1-16-4096\b/.test(spawnSync(path.join(process.env.SystemRoot ?? process.env.windir ?? '', 'System32', 'whoami.exe'), ['/groups'], { encoding: 'utf8', windowsHide: true }).stdout ?? '');

// The real thing, on Windows only: a Low-labelled node opens a test folder labelled as on labels the daemon folder.
test('w5957 N7 (Windows): a Low child is refused a No-Read-Up folder and reads a given-back one inside it', { skip: process.platform !== 'win32' ? 'not Windows' : lowSelf() ? 'this process is Low (a fenced worker): a Medium label cannot be set from Low (1299); the daemon runs this check on its own start' : false }, async (tc) => {
  const d = tmp('low');
  try {
    const node = path.join(d, 'node-low.exe');
    fs.copyFileSync(process.execPath, node);
    const low = spawnSync('icacls', [node, '/setintegritylevel', 'low'], { encoding: 'utf8' });
    assert.equal(low.status, 0, low.stdout + low.stderr);
    const exec = async (cmd: string, args: string[], o?: { timeoutMs?: number; cwd?: string }) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: o?.timeoutMs ?? 60_000, cwd: o?.cwd });
      return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const { labelNoReadUp, openNoReadUp, relabelInside, labelScript, NO_LABEL } = await import('./lowIntegrity.ts');
    const real = path.join(d, 'real');
    fs.mkdirSync(path.join(real, 'app', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(real, 'app', 'daemon.json'), '{}');
    fs.writeFileSync(path.join(real, 'app', 'sandboxes.json'), '[]');
    // w5980: a file inside a given-back folder (as app\\machine\\ghApp.ts), read after the closed parent's walk.
    fs.writeFileSync(path.join(real, 'app', 'logs', 'inside.log'), 'x');
    const labels = noReadUpTargets({ root: real, appDir: path.join(real, 'app'), allowBack: ['logs', 'sandboxes.json'] });
    const t = { closed: [path.join(real, 'app', 'daemon.json')], open: [path.join(real, 'app', 'logs'), path.join(real, 'app', 'logs', 'inside.log'), path.join(real, 'app', 'sandboxes.json')] };
    const lines: string[] = [];
    const say = (s: string) => void lines.push(s);
    const deps = { labels, t, lowNode: node, mirrorDir: path.join(d, 'mirror'), skip: () => false, run: exec, log: (l: string) => void lines.push(l),
      // As the daemon's: the labels, then NR on what inside has an explicit label of its own (this process may be elevated,
      // and a High creator's file carries an explicit High label: the w5968 finding).
      setLabels: async (l: readonly LabelTarget[]) => (await labelNoReadUp(l, exec, say, { systemDrive: () => false })) && (await relabelInside(l, 'close', exec, say, { systemDrive: () => false })),
      openLabels: async (l: readonly LabelTarget[]) => !!(await openNoReadUp(l, exec, say, { systemDrive: () => false })) && (await relabelInside(l, 'open', exec, say, { systemDrive: () => false })) };
    // The child must run Low (S-1-16-4096), or every path reads and the probe means nothing.
    // System32's whoami by full path: Git's own whoami on PATH cannot start at Low (msys, 0xC0000022).
    const whoExe = path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'whoami.exe');
    const who = spawnSync(node, ['-e', `process.stdout.write(require('child_process').execFileSync(${JSON.stringify(whoExe)}, ['/groups']).toString())`], { encoding: 'utf8', windowsHide: true });
    assert.match(who.stdout ?? '', /S-1-16-4096\b/, `the Low copy of node is not Low: ${(who.stdout ?? '').split(/\r?\n/).filter((l) => /Mandatory/i.test(l)).join(' | ')} ${who.stderr ?? ''}`);
    // node opens every file with FILE_FLAG_BACKUP_SEMANTICS (libuv), so a child holding SeBackupPrivilege or
    // SeRestorePrivilege enabled passes any label: the elevated CI runner's token does (measured at #1324's 3aed8cd7), a
    // Medium daemon's Low workers hold neither. Remove both from this process, as transcriptLabels.test.ts does (w5703), so
    // the Low child has a worker's token, and check the child: a privilege left would make every refusal here pass.
    const removed = removePrivileges(process.pid, ['SeBackupPrivilege', 'SeRestorePrivilege'], d);
    tc.diagnostic(`privileges: ${removed.split(/\s*\r?\n\s*/).join('; ')}`);
    assert.match(removed, /^SeBackupPrivilege (removed|not held)\s+SeRestorePrivilege (removed|not held)$/, removed);
    const priv = spawnSync(node, ['-e', `process.stdout.write(require('child_process').execFileSync(${JSON.stringify(whoExe)}, ['/priv']).toString())`], { encoding: 'utf8', windowsHide: true });
    const held = (priv.stdout ?? '').split(/\r?\n/).filter((l) => /^Se(Backup|Restore)Privilege\b/.test(l.trim())).map((l) => l.trim().replace(/\s+/g, ' '));
    assert.deepEqual(held, [], `the Low child still holds: ${held.join('; ')}`);
    // What the mirror's labels are once set, for the failure message (icacls names each path's mandatory label).
    const w = await probeReadFenceWin({ ...deps, mode: 'warn', setLabels: async (l: readonly LabelTarget[]) => {
      const ok = await deps.setLabels(l);
      const seen = spawnSync('icacls', [deps.mirrorDir, '/T', '/C'], { encoding: 'utf8', windowsHide: true });
      lines.push(`icacls of the mirror after setLabels: ${(seen.stdout ?? '').split(/\r?\n/).filter((x) => /Mandatory|^\S/.test(x)).join(' || ')}`);
      return ok;
    } });
    assert.equal(w.blocks, false, lines.join('\n'));
    assert.match(w.line, /1\/1 closed paths refused, 3\/3 given-back paths open; no failures/);
    // The real labels, then on's probe of the real paths; then a given-back file rewritten by rename loses its give-back
    // (N5's gap), which on's probe finds and undoes.
    assert.ok(await deps.setLabels(labels));
    const on = await probeReadFenceWin({ ...deps, mode: 'on' });
    assert.deepEqual([on.blocks, on.reverted], [false, false], lines.join('\n'));
    fs.writeFileSync(path.join(real, 'app', 'sandboxes.json.tmp'), '[1]');
    fs.renameSync(path.join(real, 'app', 'sandboxes.json.tmp'), path.join(real, 'app', 'sandboxes.json'));
    // The daemon writes at Medium, so its renamed file has no label of its own and inherits the folder's NR. This process
    // may be High, whose file carries its own High label: take that off so the file is as the daemon's would be.
    const unl = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(labelScript([{ path: path.join(real, 'app', 'sandboxes.json'), sddl: NO_LABEL }]), 'utf16le').toString('base64')]);
    assert.match(unl.stdout, /^ok 0/m, unl.stdout + unl.stderr);
    const after = await probeReadFenceWin({ ...deps, mode: 'on' });
    assert.deepEqual([after.blocks, after.reverted], [true, true], lines.join('\n'));
    assert.match(after.line, /would refuse what workers need: .*sandboxes\.json/);
    // The labels came off by themselves: a Low child reads the given-back file again (and the closed one, as in off).
    const reverted = await probeReadFenceWin({ ...deps, mode: 'on' });
    assert.deepEqual([reverted.blocks, reverted.reverted], [true, false], lines.join('\n'));
    assert.match(reverted.line, /0\/1 closed paths refused, 3\/3 given-back paths open/);
  } finally {
    // Labels at Medium do not stop the test (Medium) removing its own folder.
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// w6120: the walk's stop file for real (the C# compiled by Add-Type in Windows PowerShell 5.1): a mode file that does not
// hold the wanted mode stops the walk at its first path; one that does lets it walk to the end. It only reads labels here
// (nothing inside carries an explicit label to change), so it runs at any integrity level.
test('w6120 (Windows): relabelInside stops its walk when the mode file changes, and walks whole while it holds the mode', { skip: process.platform !== 'win32' ? 'not Windows' : false }, async () => {
  const d = tmp('stop');
  try {
    const closed = path.join(d, 'closed');
    fs.mkdirSync(path.join(closed, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(closed, 'sub', 'a.txt'), 'x');
    const file = path.join(d, 'read-fence');
    const exec = async (cmd: string, args: string[], o?: { timeoutMs?: number }) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: o?.timeoutMs ?? 120_000 });
      return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const t: LabelTarget[] = [{ path: closed, sddl: NO_READ_UP.dir }];
    let stops = 0;
    const said: string[] = [];
    fs.writeFileSync(file, 'warn\n');
    assert.equal(await relabelInside(t, 'close', exec, (l) => void said.push(l), { systemDrive: () => false, stopUnless: { file, want: 'on', onStop: () => void stops++ } }), false, said.join('\n'));
    assert.equal(stops, 1);
    assert.ok(said.some((l) => /stopped after 0 path\(s\)/.test(l)), said.join('\n'));
    said.length = 0;
    fs.writeFileSync(file, 'on\n');
    assert.equal(await relabelInside(t, 'close', exec, (l) => void said.push(l), { systemDrive: () => false, stopUnless: { file, want: 'on', onStop: () => void stops++ } }), true, said.join('\n'));
    assert.equal(stops, 1, 'a walk while the file holds the mode does not stop');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
