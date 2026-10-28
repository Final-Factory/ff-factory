// w2442: LothDesktop takes timed runs. lothsahn, 2026-10-28: "Move that job to another machine" (w2434's A/B, off the paused
// LothLaptop); timed_run took only play-only computers and small ones (1..4 agent slots, w1996), and desktop-coosego was
// offline. A big computer BIG_TIMED_RUNS names is a target too, ranked after every small one; other big ones stay out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimedRuns } from './timedRuns.ts';
import { BIG_TIMED_RUNS, SMALL_TIMED_MAX_AGENTS, timedRunSize } from './timedAsk.ts';
import type { AttachmentStore } from './attachments.ts';
import type { Machine } from '../shared/types.ts';

test('w2442: a big computer takes timed runs only when BIG_TIMED_RUNS names it (LothDesktop)', () => {
  assert.ok(BIG_TIMED_RUNS.lothdesktop);
  assert.equal(timedRunSize('lothdesktop', 12), true);
  assert.equal(timedRunSize('beast', 12), false, 'BEAST stays out');
  assert.equal(timedRunSize('lothlaptop', 1), true);
  assert.equal(timedRunSize('m3', SMALL_TIMED_MAX_AGENTS), true);
  assert.equal(timedRunSize('lothdesktop', 0), false, 'no agent slot: no worker install to run it');
});

test('w2442: LothDesktop is a timed_run target, after every small computer; asked by name it is taken', () => {
  const machines = [
    { id: 'beast', platform: 'win32', sandboxRoot: 'F:/ffw/sandboxes' },
    { id: 'lothdesktop', platform: 'win32', sandboxRoot: 'V:/ffw/sandboxes' },
    { id: 'lothlaptop', platform: 'win32', sandboxRoot: 'C:/ffw/sandboxes' },
    { id: 'desktop-coosego', platform: 'win32', playOnly: 'play only' },
  ] as unknown as Machine[];
  const agents: Record<string, number> = { beast: 12, lothdesktop: 10, lothlaptop: 1 };
  const online = new Set(['beast', 'lothdesktop', 'lothlaptop']);
  const holds: Record<string, string> = {};
  const tr = new TimedRuns({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'w2442big-')),
    store: {} as AttachmentStore,
    machines: () => machines,
    isOnline: (id) => online.has(id),
    offers: () => true,
    post: () => true,
    deliver: async () => {},
    // index.ts's smallWorker
    smallWorker: (m) => (timedRunSize(m.id, agents[m.id] ?? 0) ? { agents: agents[m.id] } : undefined),
    held: (id) => holds[id],
  });
  assert.deepEqual(tr.targets().map((x) => `${x.id}:${x.kind}`).sort(), ['desktop-coosego:play-only', 'lothdesktop:small', 'lothlaptop:small']);
  assert.match(tr.targets().find((x) => x.id === 'lothdesktop')!.why, /^a big worker computer \(10 agent slots\)$/);
  assert.deepEqual(tr.windowsTargets().map((x) => x.id), ['lothlaptop', 'lothdesktop', 'desktop-coosego'], 'the small one first');
  // LothLaptop paused by hand (held): LothDesktop is the first one free
  holds.lothlaptop = 'paused by hand from its tray';
  assert.deepEqual(tr.windowsTargets().map((x) => x.id), ['lothdesktop', 'desktop-coosego', 'lothlaptop']);
  assert.equal((tr as unknown as { target(n: unknown): string }).target('lothdesktop'), 'lothdesktop');
  assert.throws(() => (tr as unknown as { target(n: unknown): string }).target('beast'), /beast takes no timed run/);
});
