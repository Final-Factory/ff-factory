import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CleanupRunner, DEFAULT_CLEANUP, cleanupRules, describeCleanup, describeCleanupItems, describeShortfall, fenceToRoot, neverDelete, planCleanup, strictlyWithin, type CleanupEnv, type CleanupGuard, type CleanupRule } from './cleanup.ts';
import { cleanupPass, STALE_OUTPUT_DEFAULTS } from './staleOutput.ts';
import { planPlayerSlots, runOwnLeftovers } from './ownLeftovers.ts';
import type { CleanupSummary } from '../shared/types.ts';

/**
 * The install-folder fence of the daemon's own clean-up (w896, lothsahn, 2026-10-10: "Why are you clearing C: on LothDesktop? ...
 * In general we should only be clearing data in the install folder for the worker"). On a machine with a worker install, a
 * pass removes only what is strictly inside the root; whatever its rules pick outside (system temp, caches, crash dumps, Unity
 * Hub's editors) is measured and listed with the reason. A machine without a root is not fenced.
 */

const H = 3_600_000;
const D = 24 * H;
const GB = 1024 ** 3;

function world(t: { after: (fn: () => void) => void }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-fence-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, 'ffw');
  const outside = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const put = (dir: string, name: string) => {
    const p = path.join(dir, name);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'x'), 'x'.repeat(100));
    return p;
  };
  return { base, root, outside, put };
}

const guardFor = (home: string): CleanupGuard => ({ keep: [], inUse: [], home });
const item = (p: string, rule = 'temp-old') => ({ path: p, rule, why: 'test' });
const ONCE = { stale: false, dryRun: false };

test('fenceToRoot: strictly inside stays; the root itself, a sibling with the same prefix and everything else is outside', () => {
  const f = fenceToRoot([{ path: 'D:/work/ffw/tmp/ffa-1' }, { path: 'D:\\work\\ffw\\players\\slot0' }, { path: 'D:/work/ffw' }, { path: 'D:/work/ffw-old/x' }, { path: 'C:/Users/a/AppData/Local/Temp/x' }], 'D:\\work\\ffw');
  assert.deepEqual(f.inside.map((i) => i.path), ['D:/work/ffw/tmp/ffa-1', 'D:\\work\\ffw\\players\\slot0']);
  assert.deepEqual(f.outside.map((i) => i.path), ['D:/work/ffw', 'D:/work/ffw-old/x', 'C:/Users/a/AppData/Local/Temp/x']);
  assert.match(f.outside[0].why, /outside the worker install folder: clean-up deletes only inside it, so this is measured and listed, not removed \(D:\\work\\ffw\)/);
  assert.ok(strictlyWithin('F:/ffw/tmp/a', 'F:\\ffw'));
  assert.ok(!strictlyWithin('F:/ffw', 'F:\\ffw'));
});

test('the pass with a root removes only what is inside it, and lists what its rules picked outside', async (t) => {
  const { root, outside, put } = world(t);
  const inside = put(path.join(root, 'tmp'), 'ffa-old');
  const temp = put(outside, 'old-temp-entry');
  const cache = put(outside, 'npm-cache');
  const guard = guardFor(path.join(outside, 'nobody'));
  const base = { guard, mode: STALE_OUTPUT_DEFAULTS.mode, regular: async () => [item(inside, 'agent-temp'), item(temp), item(cache, 'npm-cache')], stale: async () => ({ items: [], listed: [] }) };

  const dry = await cleanupPass({ ...base, opts: { stale: false, dryRun: true }, root });
  assert.deepEqual(dry.planned?.map((p) => p.path), [inside], 'a dry run plans only what a real pass would remove');
  assert.deepEqual(dry.listed?.map((l) => l.path).sort(), [cache, temp].sort(), 'and lists the rest, measured');
  assert.ok(dry.listed?.every((l) => l.bytes >= 100 && /outside the worker install folder/.test(l.why)));

  const real = await cleanupPass({ ...base, opts: ONCE, root });
  assert.deepEqual(real.removed.map((r) => r.path), [inside]);
  assert.ok(!fs.existsSync(inside));
  assert.ok(fs.existsSync(temp) && fs.existsSync(cache), 'nothing outside the root is touched');
  assert.deepEqual(real.listed?.map((l) => l.path).sort(), [cache, temp].sort());
});

test('without a root (the portal host, an old install) the pass is unfenced, as before', async (t) => {
  const { outside, put } = world(t);
  const temp = put(outside, 'old-temp-entry');
  const r = await cleanupPass({ guard: guardFor(path.join(outside, 'nobody')), mode: STALE_OUTPUT_DEFAULTS.mode, regular: async () => [item(temp)], stale: async () => ({ items: [], listed: [] }), opts: ONCE });
  assert.deepEqual(r.removed.map((x) => x.path), [temp]);
  assert.ok(!r.listed?.length);
});

test('the stale-output rules and FF Factory\'s own leftovers are fenced too (a player slot outside the root, the old defaults)', async (t) => {
  const { root, outside, put } = world(t);
  const inSlots = path.join(root, 'players');
  const oldSlots = path.join(outside, 'old-players');
  for (const dir of [inSlots, oldSlots]) {
    put(path.join(dir, 'slot0', 'player'), 'finalfactory.exe');
    const old = (Date.now() - 3 * D) / 1000;
    for (const p of [dir, path.join(dir, 'slot0'), path.join(dir, 'slot0', 'player'), path.join(dir, 'slot0', 'player', 'finalfactory.exe'), path.join(dir, 'slot0', 'player', 'finalfactory.exe', 'x')]) fs.utimesSync(p, old, old);
  }
  const guard = guardFor(path.join(outside, 'nobody'));
  const own = {
    plan: () => planPlayerSlots({ roots: [inSlots, oldSlots], guard, host: 'h', alive: () => false, now: Date.now() }),
    run: (p: Awaited<ReturnType<typeof planPlayerSlots>>) => runOwnLeftovers(p, async () => undefined),
  };
  const stale = async () => ({ items: [item(path.join(outside, 'Builds', 'w1'), 'stale-build')], listed: [] });
  const r = await cleanupPass({ guard, mode: 'on', regular: async () => [], stale, own, opts: { stale: true, dryRun: false }, root });
  assert.deepEqual(r.removed.map((x) => x.path), [path.join(inSlots, 'slot0')]);
  assert.ok(fs.existsSync(path.join(oldSlots, 'slot0')), 'a slot in an old default outside the root stays');
  assert.deepEqual(r.listed?.map((l) => l.path).sort(), [path.join(outside, 'Builds', 'w1'), path.join(oldSlots, 'slot0')].sort());
});

test('the rules by place (w896 audit): on a worker root what lies outside is listed, only the temp, builds and slots inside it go', () => {
  // LothDesktop's shape: root D:/work/ffw with its own temp and sandboxes; the user's profile on C:.
  const env: CleanupEnv = { platform: 'win32', home: 'C:/Users/loth', tmp: 'C:/Users/loth/AppData/Local/Temp', localAppData: 'C:/Users/loth/AppData/Local', agentTemp: 'D:/work/ffw/tmp', sandboxRoots: ['D:/work/ffw/sandboxes'] };
  const rules = cleanupRules(env, DEFAULT_CLEANUP);
  const where = (r: CleanupRule) => (strictlyWithin(r.dir.replace(/\*/g, 'x'), 'D:/work/ffw') ? 'inside' : 'outside');
  const inside = new Set(rules.filter((r) => where(r) === 'inside').map((r) => r.id));
  const outside = new Set(rules.filter((r) => where(r) === 'outside').map((r) => r.id));
  // Inside: the agents' own temp (also scanned for Claude Code's task files) and the sandboxes' Builds.
  assert.deepEqual([...inside].sort(), ['agent-temp', 'claude-edit-diff', 'claude-temp', 'sandbox-builds', 'temp-clones', 'temp-old', 'temp-scratch']);
  // Outside, so only listed now: crash dumps, Unity's logs and caches, the npm / NuGet / pip / uv caches, playtest output in LocalLow, Playwright, runner jobs, ff-worker archives.
  for (const id of ['crash-dumps', 'unity-crashes', 'unity-logs', 'unity-gi-cache', 'unity-cache', 'unity-cache-low', 'npx', 'npm-cache', 'nuget-http', 'pip-cache', 'uv-cache', 'playtest-sessions', 'playwright', 'edge-webview', 'actions-work', 'worker-archives']) assert.ok(outside.has(id), id);
  // The same rules land in the fence's list when they pick something: a crash dump on C:.
  assert.deepEqual(fenceToRoot([{ path: 'C:/Users/loth/AppData/Local/CrashDumps/a.dmp' }, { path: 'D:/work/ffw/tmp/ffa-9' }], 'D:/work/ffw').inside.map((x) => x.path), ['D:/work/ffw/tmp/ffa-9']);
});

test('planCleanup still plans outside the root (the fence is the pass\'s), so a dry run can say what it kept', async (t) => {
  const { outside, put } = world(t);
  const old = put(outside, 'stale-dir');
  const at = (Date.now() - 20 * D) / 1000;
  fs.utimesSync(path.join(old, 'x'), at, at);
  fs.utimesSync(old, at, at);
  const items = await planCleanup({ rules: [{ id: 'temp-old', dir: outside, olderThanHours: 24, what: 'temp entry' }], guard: { keep: [], inUse: [], home: path.join(outside, 'nobody') } });
  assert.deepEqual(items.map((i) => i.path), [old]);
  assert.equal(neverDelete(old, guardFor(path.join(outside, 'nobody'))), undefined);
});

test('the notice for a pass that cannot free enough tells a worker to delete inside the install folder only, and tags the consumers', () => {
  const s: CleanupSummary = {
    at: '2026-10-10T17:00:00.000Z',
    trigger: 'low-space',
    removed: 2,
    freedBytes: 3 * GB,
    freeBytes: 68.5 * GB,
    softFreeGB: 80,
    root: 'D:\\work\\ffw',
    belowSoft: true,
    consumers: [
      { path: 'C:\\Users\\loth\\AppData\\Local', bytes: 40 * GB },
      { path: 'D:\\work\\ffw\\sandboxes', bytes: 300 * GB },
    ],
  };
  const text = describeShortfall(s);
  assert.match(text, /Clean-up work on this computer deletes only inside its worker install folder D:\\work\\ffw \(w896\)/);
  assert.match(text, /a worker only measures and reports, with sizes, and it lists any setting or script that makes FF Factory write there so it can be moved inside the folder; it deletes nothing outside/);
  assert.match(text, /C:\\Users\\loth\\AppData\\Local 40\.0 GB \[outside it: measure only\]/);
  assert.match(text, /D:\\work\\ffw\\sandboxes 300\.0 GB \[inside the install folder\]/);
  // Without a root (the portal's own host) there is no folder to name and no tags.
  const host = describeShortfall({ ...s, root: undefined });
  assert.ok(!/install folder/.test(host));
  assert.match(host, /Biggest remaining: C:\\Users\\loth\\AppData\\Local 40\.0 GB, D:/);
});

test('the runner puts the root in every summary and the pass log; listed items read as kept for a person', async () => {
  const log: object[] = [];
  const r = new CleanupRunner({
    settings: () => ({ everyMinutes: 60, softFreeGB: 80 }),
    diskPaths: () => ['/d'],
    statfs: async () => ({ free: 100 * GB, total: 200 * GB, type: 0xef53, dev: 1 }),
    pass: async () => ({ removed: [], failed: [], bytes: 0, listed: [{ path: 'C:/Users/loth/AppData/Local/Temp/x', bytes: 5 * GB, why: 'outside the worker install folder: clean-up deletes only inside it, so this is measured and listed, not removed (D:/work/ffw)' }] }),
    consumers: async () => [],
    root: () => 'D:/work/ffw',
    log: (e) => log.push(e),
    done: () => undefined,
  });
  const s = await r.run('asked');
  assert.equal(s?.root, 'D:/work/ffw');
  assert.equal((log[0] as CleanupSummary).root, 'D:/work/ffw');
  assert.match(describeCleanup(s!), /1 stale-looking item\(s\) it kept for a person: not attributable to a request, or outside the worker install folder\./);
  assert.match(describeCleanupItems(s!), /Kept, for a person \(not attributable to a request, or outside the worker install folder; look at these\):\n- C:\/Users\/loth\/AppData\/Local\/Temp\/x {2}5\.0 GB/);
  const none = new CleanupRunner({ settings: () => ({ everyMinutes: 60, softFreeGB: 80 }), diskPaths: () => ['/d'], statfs: async () => ({ free: 100 * GB, total: 200 * GB, type: 0xef53, dev: 1 }), pass: async () => ({ removed: [], failed: [], bytes: 0 }), consumers: async () => [], log: () => undefined, done: () => undefined });
  assert.equal((await none.run('asked'))?.root, undefined);
});
