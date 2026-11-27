import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  assert.deepEqual(freezeWatchSettings({ afterMin: 10, repeatMin: 2 }), { afterMin: 10, repeatMin: 2 });
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
