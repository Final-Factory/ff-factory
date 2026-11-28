import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { FREEZE_DEFAULTS, freezeWatchSettings, startFreezeWatch } from './freezeWatch.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A synchronous busy wait: the main loop is frozen for `ms`, as by the 891 s realpath block on BEAST (w6546). */
function holdTheLoopFor(ms: number): number {
  const end = Date.now() + ms;
  let n = 0;
  while (Date.now() < end) n++;
  return n;
}

function outFile(): { file: string; fd: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-watch-'));
  const file = path.join(dir, 'daemon.log');
  return { file, fd: fs.openSync(file, 'a') };
}

test('settings: defaults, bounds, and false turns it off', () => {
  assert.deepEqual(freezeWatchSettings(undefined), FREEZE_DEFAULTS);
  assert.deepEqual(freezeWatchSettings({ afterMin: 10, repeatMin: 2 }), { afterMin: 10, repeatMin: 2, exitMin: 3 });
  assert.deepEqual(freezeWatchSettings({ exitMin: false }), { ...FREEZE_DEFAULTS, exitMin: false });
  assert.deepEqual(freezeWatchSettings({ exitMin: 7 }), { ...FREEZE_DEFAULTS, exitMin: 7 });
  assert.deepEqual(freezeWatchSettings({ exitMin: 0 }), FREEZE_DEFAULTS);
  assert.deepEqual(freezeWatchSettings({ afterMin: 0, repeatMin: 'x' }), FREEZE_DEFAULTS);
  assert.deepEqual(freezeWatchSettings({ afterMin: 61 }), FREEZE_DEFAULTS);
  assert.equal(freezeWatchSettings(false), undefined);
});

test('a frozen loop is logged while it is frozen, with the main thread\'s stack, and the process goes on', async () => {
  const { file, fd } = outFile();
  const w = startFreezeWatch({ afterMs: 1000, repeatMs: 60_000, fd, beatMs: 50, everyMs: 50 });
  try {
    await sleep(300); // the thread is up and has seen beats
    const t0 = Date.now();
    holdTheLoopFor(3000);
    const held = Date.now() - t0;
    await sleep(300); // the stack exchange's last messages
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const frozen = lines.filter((l) => / event loop: frozen for \d+ s so far /.test(l));
    assert.equal(frozen.length, 1, `one line per freeze while repeatMs has not passed: ${lines.join(' | ')}`);
    assert.match(frozen[0], /the daemon answers nothing; the freeze watch only logs \(w6555\)/);
    const stack = lines.find((l) => l.includes("the daemon's main thread is in "));
    assert.ok(stack, `the stack line: ${lines.join(' | ')}`);
    assert.match(stack!, /holdTheLoopFor \(machine\/freezeWatch\.test\.ts:\d+\)/);
    // The line came during the freeze, not after it: its time is before the busy wait ended.
    const at = Date.parse(frozen[0].split(' ')[0]);
    assert.ok(at < t0 + held, `logged at ${frozen[0].split(' ')[0]}, the freeze ended ${new Date(t0 + held).toISOString()}`);
    // The main thread was resumed after its stack was read: it runs on.
    assert.equal(await Promise.resolve(41 + 1), 42);
  } finally {
    w.stop();
    fs.closeSync(fd);
  }
});

test('a freeze that goes on is said again every repeatMs; a loop that beats says nothing', async () => {
  const { file, fd } = outFile();
  const w = startFreezeWatch({ afterMs: 1500, repeatMs: 1200, fd, beatMs: 50, everyMs: 50 });
  try {
    await sleep(900); // beating (a loaded test machine's loop stalls up to about 1 s; the threshold is above it): nothing
    assert.equal(fs.readFileSync(file, 'utf8'), '');
    holdTheLoopFor(4000);
    await sleep(300);
    const frozen = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('event loop: frozen for'));
    assert.ok(frozen.length >= 2 && frozen.length <= 3, `2-3 lines in a 4 s freeze, from 1.5 s, 1.2 s apart: ${frozen.join(' | ')}`);
  } finally {
    w.stop();
    fs.closeSync(fd);
  }
});

// Stage 2: a child process stands in for the daemon, since the watch ends the whole process.
test('a freeze that reaches exitMs ends the process, after its stack is in the log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-exit-'));
  const log = path.join(dir, 'daemon.log');
  const child = path.join(dir, 'frozen-daemon.mjs');
  const watch = pathToFileURL(path.resolve(import.meta.dirname, 'freezeWatch.ts')).href;
  fs.writeFileSync(
    child,
    `import fs from 'node:fs';
import { startFreezeWatch } from ${JSON.stringify(watch)};
const fd = fs.openSync(${JSON.stringify(log)}, 'a');
startFreezeWatch({ afterMs: 1000, repeatMs: 60_000, exitMs: 2000, fd, beatMs: 50, everyMs: 50 });
function holdTheLoopFor(ms) { const end = Date.now() + ms; let n = 0; while (Date.now() < end) n++; return n; }
setTimeout(() => { holdTheLoopFor(30_000); fs.writeSync(fd, 'NOT ENDED\\n'); process.exit(0); }, 300);
`,
  );
  const t0 = Date.now();
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', child], { stdio: 'ignore' });
  const done = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => p.on('exit', (code, signal) => r({ code, signal })));
  const took = Date.now() - t0;
  const text = fs.readFileSync(log, 'utf8');
  assert.ok(took < 15_000, `ended in ${took} ms, not after the 30 s hold: ${text}`);
  assert.ok(!text.includes('NOT ENDED'), text);
  // SIGKILL on POSIX; TerminateProcess (exit code 1) on Windows. Neither is 0 or 75, so every supervisor restarts it.
  if (process.platform === 'win32') assert.equal(done.code, 1, JSON.stringify(done));
  else assert.equal(done.signal, 'SIGKILL', JSON.stringify(done));
  const lines = text.trim().split('\n');
  assert.ok(lines.some((l) => / event loop: frozen for \d+ s so far .*it is ended at 2 s \(w6555\)/.test(l)), `the warning at afterMs: ${text}`);
  const ending = lines.findIndex((l) => l.includes('; ending it so its supervisor starts a fresh one (w6555)'));
  assert.ok(ending >= 0, `the line at exitMs: ${text}`);
  const stack = lines.findIndex((l, i) => i > ending && /main thread is in holdTheLoopFor \(/.test(l));
  assert.ok(stack > ending, `the stack after it: ${text}`);
  assert.ok(lines.findIndex((l) => l.includes('event loop: ending the daemon now (SIGKILL)')) > stack, `the kill line, last: ${text}`);
});

// w6611's review: after a sleep (here SIGSTOP/SIGCONT, which holds both threads), a short busy job on wake was measured from
// the beat before the sleep and the daemon was killed. A freeze is measured from the wake. POSIX only: Windows has no SIGSTOP.
test('a job just after a sleep is not taken for a freeze', { skip: process.platform === 'win32' && 'no SIGSTOP on Windows' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-sleep-'));
  const log = path.join(dir, 'daemon.log');
  const child = path.join(dir, 'sleepy-daemon.mjs');
  const watch = pathToFileURL(path.resolve(import.meta.dirname, 'freezeWatch.ts')).href;
  fs.writeFileSync(
    child,
    `import fs from 'node:fs';
import { startFreezeWatch } from ${JSON.stringify(watch)};
const fd = fs.openSync(${JSON.stringify(log)}, 'a');
startFreezeWatch({ afterMs: 1000, repeatMs: 60_000, exitMs: 3000, fd, beatMs: 50, everyMs: 50 });
function holdTheLoopFor(ms) { const end = Date.now() + ms; let n = 0; while (Date.now() < end) n++; return n; }
let prev = Date.now();
fs.writeSync(fd, 'READY\n');
const t = setInterval(() => {
  const now = Date.now();
  // Woken: a 2 s job, under exitMs from the wake but far over it from the beat before the stop.
  if (now - prev > 3000) { clearInterval(t); holdTheLoopFor(2000); fs.writeSync(fd, 'SURVIVED\n'); process.exit(0); }
  prev = now;
}, 100);
`,
  );
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', child], { stdio: 'ignore' });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => p.on('exit', (code, signal) => r({ code, signal })));
  const guard = setTimeout(() => p.kill('SIGKILL'), 30_000);
  try {
    for (let i = 0; i < 100 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('READY')); i++) await sleep(100);
    await sleep(500); // beating
    p.kill('SIGSTOP');
    await sleep(7000); // longer than the watch's own 5 s held line, and than exitMs
    p.kill('SIGCONT');
    const done = await exited;
    const text = fs.readFileSync(log, 'utf8');
    assert.deepEqual(done, { code: 0, signal: null }, text);
    assert.ok(text.includes('SURVIVED'), text);
    assert.ok(!text.includes('ending it so its supervisor'), text);
  } finally {
    clearTimeout(guard);
  }
});
