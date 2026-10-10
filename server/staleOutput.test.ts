import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSetting } from './appConfig.ts';
import { CleanupRunner, runCleanup, staleAtFile, type CleanupGuard, type CleanupRun, type PassOptions } from './cleanup.ts';
import { STALE_OUTPUT_DEFAULTS, cleanupPass, planStaleOutput, requestIdsIn, staleContextOf, staleOutputSettings, type StaleContext, type StalePlace } from './staleOutput.ts';

/**
 * The stale build and run output rules (w459, server/staleOutput.ts): what goes, what stays, and what is listed for a
 * person, in a sandbox laid out like BEAST's and LothDesktop's on 2026-10-05.
 */

const H = 3_600_000;
const NOW = Date.parse('2026-10-05T12:00:00Z');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);

/** A file (and its folders) under `root`, everything in it last changed `hoursAgo`. */
function put(root: string, rel: string, hoursAgo: number, bytes = 10) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x'.repeat(bytes));
  age(p, hoursAgo);
  return p;
}

/** Set `p` and everything inside it to have last changed `hoursAgo`. */
function age(p: string, hoursAgo: number) {
  const t = (NOW - hoursAgo * H) / 1000;
  const walk = (q: string) => {
    if (fs.statSync(q).isDirectory()) for (const n of fs.readdirSync(q)) walk(path.join(q, n));
    fs.utimesSync(q, t, t);
  };
  walk(p);
}

/** Age the folders on the way from `root` down to every file (put() leaves the parents new). */
function ageAll(root: string, hoursAgo: number, except: string[] = []) {
  const t = (NOW - hoursAgo * H) / 1000;
  const walk = (q: string) => {
    if (except.some((e) => path.resolve(q) === path.resolve(e))) return;
    const st = fs.statSync(q);
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(q)) walk(path.join(q, n));
      fs.utimesSync(q, t, t);
    }
  };
  walk(root);
}

function tmp(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

const CTX: StaleContext = { at: new Date(NOW - H).toISOString(), open: ['w393', 'w409'], closed: ['w95', 'w166', 'w63'] };

/** A sandbox root with one sandbox, laid out as found on BEAST (F:/ffsb/<sb>/Builds) and LothDesktop (.nightly-builds). */
function sandbox(root: string) {
  const sb = path.join(root, 'ffsb', 'sb1');
  const days = (d: number) => d * 24;
  const f = {
    closedBuild: put(sb, 'Builds/w95/player/finalfactory.exe', days(5), 1000),
    closedBuildRecent: put(sb, 'Builds/w63-clips/a.mp4', 2),
    openBuild: put(sb, 'Builds/w393-facing/player.exe', days(6)),
    unknownRequest: put(sb, 'Builds/w9999-x/a.bin', days(6)),
    shaOld: put(sb, `Builds/${SHA_A}-win/player/finalfactory.exe`, days(3), 2000),
    shaNew: put(sb, `Builds/${SHA_B}-win/player/finalfactory.exe`, 20),
    unattributed: put(sb, 'Builds/perf/run1/log.txt', days(8)),
    clonedRepo: put(sb, 'Builds/w166-clone/.git/HEAD', days(9)),
    nightlyShaOld: put(sb, `.nightly-builds/${SHA_C}-win/player/finalfactory.exe`, days(4), 3000),
    nightlyRunClosed: put(sb, '.nightly-builds/runs/w166-final-sp/result.json', days(3)),
    nightlyRunOpen: put(sb, '.nightly-builds/runs/w409-proof/result.json', days(30)),
    nightlyRunOld: put(sb, '.nightly-builds/runs/adhoc-a/result.json', days(20)),
    nightlyRunYoung: put(sb, '.nightly-builds/runs/adhoc-b/result.json', days(5)),
    nightlyOther: put(sb, '.nightly-builds/proofclone/README', days(10)),
    temp: put(sb, 'Temp/Bee/artifact', 12),
    logOld: put(sb, 'Logs/sandbox-editor-old.log', days(20)),
    logNew: put(sb, 'Logs/sandbox-editor.log', 3),
    // Never looked into, whatever their names and ages say.
    library: put(sb, 'Library/w95/Artifacts/x', days(400)),
    inbox: put(sb, 'Inbox/w95-save.zip', days(60)),
    assets: put(sb, `Assets/Builds/${SHA_D}-win/x`, days(60)),
    saves: put(sb, 'Saves/w95.zip', days(60)),
  };
  ageAll(sb, days(10), [path.join(sb, 'Builds', 'w63-clips'), path.join(sb, `Builds/${SHA_B}-win`), path.join(sb, 'Logs')]);
  age(path.join(sb, 'Temp'), 12);
  age(path.join(sb, '.nightly-builds', 'runs', 'adhoc-a'), days(20));
  age(path.join(sb, '.nightly-builds', 'runs', 'adhoc-b'), days(5));
  age(path.join(sb, '.nightly-builds', 'runs', 'w409-proof'), days(30));
  age(path.join(sb, 'Builds', 'w63-clips'), 2);
  age(path.join(sb, `Builds/${SHA_B}-win`), 20);
  return { sb, f };
}

const guardFor = (root: string, extra: Partial<CleanupGuard> = {}): CleanupGuard => ({ keep: [path.join(root, 'ffsb')], inUse: [], home: path.join(root, 'home'), ...extra });
const places = (sb: string, editorRunning: boolean | 'unknown' = false): StalePlace[] => [{ id: 'sb1', path: sb, kind: 'sandbox', ...(editorRunning === 'unknown' ? {} : { editorRunning }) }];
const rel = (root: string, p: string) => path.relative(root, p).replace(/\\/g, '/');

test('stale output: closed requests, old commit builds, old runs, a stopped editor\'s Temp and old logs go; the rest stays or is listed', async (t) => {
  const root = tmp(t);
  const { sb } = sandbox(root);
  const plan = await planStaleOutput({ places: places(sb), nightlyRoots: [], ctx: CTX, settings: STALE_OUTPUT_DEFAULTS, guard: guardFor(root), now: NOW });
  const items = Object.fromEntries(plan.items.map((i) => [rel(sb, i.path), i]));
  assert.deepEqual(Object.keys(items).sort(), [
    '.nightly-builds/cccccccccccccccccccccccccccccccccccccccc-win',
    '.nightly-builds/runs/adhoc-a',
    '.nightly-builds/runs/w166-final-sp',
    `Builds/${SHA_A}-win`,
    'Builds/w95',
    'Logs/sandbox-editor-old.log',
    'Temp',
  ]);
  assert.match(items['Builds/w95'].why, /build output for w95, closed in the ledger/);
  assert.match(items[`Builds/${SHA_A}-win`].why, /player build of commit aaaaaaaaaaaa \(rebuildable\)/);
  assert.match(items['.nightly-builds/runs/adhoc-a'].why, /e2e run output untouched for 14 days/);
  assert.match(items.Temp.why, /Unity's Temp of a stopped editor \(sb1\)/);
  for (const i of plan.items) assert.equal(i.base, sb, 'each item is relative to its place, so the sandbox root keep does not cover it');

  const listed = Object.fromEntries(plan.listed.map((l) => [rel(sb, l.path), l.why]));
  assert.deepEqual(Object.keys(listed).sort(), ['.nightly-builds/proofclone', 'Builds/perf', 'Builds/w166-clone', 'Builds/w9999-x']);
  assert.match(listed['Builds/perf'], /not attributable to a request or a commit \(sb1\)/);
  assert.match(listed['Builds/w9999-x'], /w9999, which the ledger does not know/);
  assert.match(listed['Builds/w166-clone'], /holds a git repo/, 'a closed request, but a repo inside: never removed');
  // Kept silently: an open request's output, anything changed within a day, a commit build younger than its age.
  for (const k of ['Builds/w393-facing', 'Builds/w63-clips', `Builds/${SHA_B}-win`, '.nightly-builds/runs/w409-proof', '.nightly-builds/runs/adhoc-b', 'Logs/sandbox-editor.log']) {
    assert.equal(items[k], undefined, k);
    assert.equal(listed[k], undefined, k);
  }
  // Library, Inbox, Assets and anything else of a place are never looked at.
  for (const p of [...plan.items.map((i) => i.path), ...plan.listed.map((l) => l.path)]) assert.doesNotMatch(rel(sb, p), /^(Library|Inbox|Assets|Saves)\b/);
});

test('stale output: a running (or unknown) editor keeps its Temp and logs; Temp with a lock file stays; no ledger facts: request output is listed', async (t) => {
  const root = tmp(t);
  const { sb } = sandbox(root);
  for (const running of [true, 'unknown'] as const) {
    const plan = await planStaleOutput({ places: places(sb, running), nightlyRoots: [], ctx: CTX, settings: STALE_OUTPUT_DEFAULTS, guard: guardFor(root), now: NOW });
    assert.ok(!plan.items.some((i) => /Temp|Logs/.test(rel(sb, i.path))), `editor ${running}`);
  }
  put(sb, 'Temp/UnityLockfile', 12);
  age(path.join(sb, 'Temp'), 12);
  let plan = await planStaleOutput({ places: places(sb), nightlyRoots: [], ctx: CTX, settings: STALE_OUTPUT_DEFAULTS, guard: guardFor(root), now: NOW });
  assert.ok(!plan.items.some((i) => rel(sb, i.path) === 'Temp'), 'an editor holds Temp/UnityLockfile');

  // The ledger's facts are missing, or two days old: nothing goes for a request; commit builds still do.
  for (const ctx of [undefined, { ...CTX, at: new Date(NOW - 49 * H).toISOString() }]) {
    plan = await planStaleOutput({ places: places(sb), nightlyRoots: [], ctx, settings: STALE_OUTPUT_DEFAULTS, guard: guardFor(root), now: NOW });
    const items = plan.items.map((i) => rel(sb, i.path));
    assert.ok(!items.includes('Builds/w95') && !items.includes('.nightly-builds/runs/w166-final-sp'));
    assert.ok(items.includes(`Builds/${SHA_A}-win`));
    assert.match(plan.listed.find((l) => rel(sb, l.path) === 'Builds/w95')!.why, /ledger's facts are missing or old/);
  }
});

test('stale output: the guard still wins (in use, protected, backups); a request named twice goes only when both are closed', async (t) => {
  const root = tmp(t);
  const { sb } = sandbox(root);
  const both = put(sb, 'Builds/w95-vs-w393/a', 24 * 5);
  ageAll(path.join(sb, 'Builds', 'w95-vs-w393'), 24 * 5);
  const guard = guardFor(root, { inUse: [path.join(sb, 'Builds', 'w95')], keep: [path.join(root, 'ffsb'), path.join(sb, `Builds/${SHA_A}-win`)] });
  const plan = await planStaleOutput({ places: places(sb), nightlyRoots: [], ctx: CTX, settings: STALE_OUTPUT_DEFAULTS, guard, now: NOW });
  const items = plan.items.map((i) => rel(sb, i.path));
  assert.ok(!items.includes('Builds/w95'), 'in use by a running agent');
  assert.ok(!items.includes(`Builds/${SHA_A}-win`), 'kept explicitly');
  assert.ok(!items.includes(rel(sb, path.dirname(both))), 'w393 is still open');

  // A backup folder of a person's work is never a place's output, whatever it is called.
  const backups = put(root, `ffsb/sb1/Builds/ff-local-backups/${SHA_C}-win/x`, 24 * 30);
  ageAll(path.join(sb, 'Builds', 'ff-local-backups'), 24 * 30);
  const again = await planStaleOutput({ places: places(sb), nightlyRoots: [], ctx: CTX, settings: STALE_OUTPUT_DEFAULTS, guard: guardFor(root), now: NOW });
  assert.ok(!again.items.some((i) => i.path.startsWith(path.dirname(path.dirname(backups)))));
});

test('stale output: the nightly lab keeps its newest builds and young runs; its checkout and reports are never touched', async (t) => {
  const root = tmp(t);
  const lab = path.join(root, 'nightly');
  put(lab, `builds/${SHA_A}-win/player/x.exe`, 24 * 9);
  put(lab, `builds/${SHA_B}-win/player/x.exe`, 24 * 7);
  put(lab, `builds/${SHA_C}-win/player/x.exe`, 24 * 5);
  put(lab, `builds/${SHA_D}-win/player/x.exe`, 24 * 3);
  put(lab, 'runs/2026-09-01/run.json', 24 * 34);
  put(lab, 'runs/2026-10-03/run.json', 24 * 2);
  put(lab, 'logs/nightly-2026-09-01.log', 24 * 34);
  put(lab, 'FinalFactory/.git/HEAD', 24 * 60);
  put(lab, 'reports/2026-09-01.md', 24 * 34);
  ageAll(path.join(lab, 'builds'), 0);
  for (const [sha, d] of [[SHA_A, 9], [SHA_B, 7], [SHA_C, 5], [SHA_D, 3]] as const) age(path.join(lab, 'builds', `${sha}-win`), 24 * d);
  age(path.join(lab, 'runs', '2026-09-01'), 24 * 34);
  age(path.join(lab, 'runs', '2026-10-03'), 24 * 2);
  const plan = await planStaleOutput({ places: [], nightlyRoots: [lab], ctx: CTX, settings: STALE_OUTPUT_DEFAULTS, guard: guardFor(root), now: NOW });
  assert.deepEqual(plan.items.map((i) => rel(lab, i.path)).sort(), [`builds/${SHA_A}-win`, `builds/${SHA_B}-win`, 'logs/nightly-2026-09-01.log', 'runs/2026-09-01']);
});

test('stale output: removal checks the guard again, logs why, and leaves nothing behind; dry runs and dry-run mode remove nothing stale', async (t) => {
  const root = tmp(t);
  const { sb, f } = sandbox(root);
  const guard = guardFor(root);
  const scratch = put(root, 'tmp/old-scratch', 24 * 10);
  const regular = async () => [{ path: scratch, rule: 'temp-old', why: 'temp entry untouched for a long time' }];
  const stale = () => planStaleOutput({ places: places(sb), nightlyRoots: [], ctx: CTX, settings: STALE_OUTPUT_DEFAULTS, guard, now: NOW });
  const pass = (opts: PassOptions, mode: 'on' | 'dry-run' | 'off') => cleanupPass({ opts, guard, mode, regular, stale });

  const dry = await pass({ stale: true, dryRun: true }, 'on');
  assert.equal(dry.removed.length, 0);
  assert.equal(dry.planned!.length, 8, 'the regular entry and the seven stale ones');
  assert.ok(dry.planned![0].bytes >= dry.planned![1].bytes, 'biggest first');
  assert.equal(dry.listed!.length, 4);
  assert.ok(fs.existsSync(f.closedBuild) && fs.existsSync(scratch), 'a dry run removes nothing');

  const off = await pass({ stale: true, dryRun: false }, 'off');
  assert.deepEqual(off.removed.map((r) => r.rule), ['temp-old'], 'off: only the regular rules');
  assert.equal(off.listed!.length, 0);

  const dryMode = await pass({ stale: true, dryRun: false }, 'dry-run');
  assert.equal(dryMode.removed.length, 0);
  assert.equal(dryMode.planned!.length, 7, 'dry-run mode: stale output measured, reported, kept');
  assert.ok(fs.existsSync(f.closedBuild));

  const real = await pass({ stale: true, dryRun: false }, 'on');
  assert.equal(real.removed.length, 7);
  assert.ok(real.removed.every((r) => r.why), 'every removal says why');
  for (const k of ['closedBuild', 'shaOld', 'nightlyShaOld', 'nightlyRunClosed', 'nightlyRunOld', 'temp', 'logOld'] as const) assert.equal(fs.existsSync(f[k]), false, k);
  for (const k of ['openBuild', 'shaNew', 'unattributed', 'clonedRepo', 'nightlyRunOpen', 'nightlyRunYoung', 'nightlyOther', 'logNew', 'library', 'inbox', 'assets', 'saves', 'closedBuildRecent', 'unknownRequest'] as const) assert.equal(fs.existsSync(f[k]), true, k);
  assert.deepEqual(fs.readdirSync(path.join(sb, 'Builds')).filter((n) => /ffclean/.test(n)), [], 'no half-removed leftovers');

  // A plan made earlier is checked again: an item that became in use is refused.
  const late = await runCleanup([{ path: f.openBuild, rule: 'stale-build', why: 'x', base: sb }], { ...guard, inUse: [path.dirname(f.openBuild)] });
  assert.match(late.failed[0].why, /refused: in use by a running agent/);
});

test('stale output: its own daily turn (never right at start), sooner when space is low, and every dry run', async () => {
  let now = NOW;
  const calls: PassOptions[] = [];
  let free = 500;
  const r = new CleanupRunner({
    settings: () => ({ everyMinutes: 60, softFreeGB: 80, staleOutput: STALE_OUTPUT_DEFAULTS }),
    diskPaths: () => ['/x'],
    statfs: async () => ({ free: free * 1024 ** 3, total: 1000 * 1024 ** 3 }),
    pass: async (_low, opts) => {
      calls.push(opts);
      return { removed: [], failed: [], bytes: 0 } as CleanupRun;
    },
    consumers: async () => [],
    log: () => {},
    done: () => {},
    now: () => now,
  });
  now += 61 * 60_000;
  await r.tick();
  assert.deepEqual(calls.pop(), { stale: false, dryRun: false }, 'the first hourly pass after a deploy leaves stale output alone');
  const dry = await r.run('asked', { dryRun: true });
  assert.deepEqual(calls.pop(), { stale: true, dryRun: true });
  assert.equal(dry?.dryRun, true);
  now += 23 * H;
  await r.tick();
  assert.equal(calls.pop()!.stale, true, 'a day after start: its turn');
  now += 61 * 60_000;
  await r.tick();
  assert.equal(calls.pop()!.stale, false, 'not again within the day');
  free = 50;
  now += 16 * 60_000;
  await r.tick();
  assert.equal(calls.pop()!.stale, true, 'low space: every pass includes it');
});

test('stale output: the daily turn survives restarts (kept on disk), and the first one comes a full day after the first start', async (t) => {
  const dir = tmp(t);
  const file = staleAtFile(dir);
  let now = NOW;
  const calls: PassOptions[] = [];
  const runner = () =>
    new CleanupRunner({
      settings: () => ({ everyMinutes: 60, softFreeGB: 0, staleOutput: STALE_OUTPUT_DEFAULTS }),
      diskPaths: () => [],
      statfs: async () => undefined,
      pass: async (_low, opts) => {
        calls.push(opts);
        return { removed: [], failed: [], bytes: 0 };
      },
      consumers: async () => [],
      log: () => {},
      done: () => {},
      staleAt: file,
      now: () => now,
    });
  runner();
  assert.equal(file.load(), NOW, 'the first start is recorded');
  now += 20 * H;
  await runner().run('hourly');
  assert.equal(calls.pop()!.stale, false, 'a restart 20 h later does not reset the clock: 4 h to go');
  now += 5 * H;
  await runner().run('hourly');
  assert.equal(calls.pop()!.stale, true, 'another restart, past the day: its turn');
  assert.equal(file.load(), now);
});

test('stale output: request ids in names, the ledger facts (stalled counts as open), and the settings', () => {
  assert.deepEqual(requestIdsIn('w393-facing'), ['w393']);
  assert.deepEqual(requestIdsIn('results-w166-final-W63'), ['w166', 'w63']);
  assert.deepEqual(requestIdsIn('win64-build'), [], '"win" is no request');
  assert.deepEqual(requestIdsIn('sw95'), [], 'inside a word: not a request');
  assert.deepEqual(requestIdsIn('2b4f4c873d1c5ca975af5ccc00d3c9c3a8aa8fe6-win'), []);
  const ctx = staleContextOf([{ id: 'w1', status: 'active' }, { id: 'W2', status: 'stalled' }, { id: 'w3', status: 'merged' }, { id: 'w4', status: 'done' }, { id: 'w5', status: 'cancelled' }, { id: 'w6', status: 'rejected' }], NOW);
  assert.deepEqual(ctx, { at: new Date(NOW).toISOString(), open: ['w1', 'w2'], closed: ['w3', 'w4', 'w5', 'w6'] });
  assert.deepEqual(staleOutputSettings(undefined), STALE_OUTPUT_DEFAULTS);
  assert.deepEqual(staleOutputSettings({ mode: 'dry-run', shaBuildDays: 5, untouchedHours: 1, everyHours: 'x', nightlyRoots: ['D:/lab', 3] }), { ...STALE_OUTPUT_DEFAULTS, mode: 'dry-run', shaBuildDays: 5, nightlyRoots: ['D:/lab'] }, 'out of range or ill-typed: the default');
});

test('stale output: set_app_config takes its block for this host and for every machine, known keys in range only', () => {
  const cfg = { hostGuard: { warnFreeGB: 80, cleanup: {} } } as unknown as Parameters<typeof normalizeSetting>[2];
  assert.deepEqual(normalizeSetting('machines.cleanup.staleOutput', { mode: 'dry-run' }, cfg), { mode: 'dry-run' });
  assert.deepEqual(normalizeSetting('hostGuard.cleanup.staleOutput', '{"shaBuildDays": 3, "runRetentionDays": 30}', cfg), { shaBuildDays: 3, runRetentionDays: 30 });
  assert.throws(() => normalizeSetting('machines.cleanup.staleOutput', { mode: 'always' }, cfg), /mode is on, dry-run or off/);
  assert.throws(() => normalizeSetting('machines.cleanup.staleOutput', { untouchedHours: 1 }, cfg), /untouchedHours 6-720/);
  assert.throws(() => normalizeSetting('machines.cleanup.staleOutput', { libraries: true }, cfg), /unknown key "libraries"/);
  assert.throws(() => normalizeSetting('machines.cleanup.staleOutput', 'on', cfg), /is an object such as/);
  assert.equal(normalizeSetting('machines.cleanup.staleOutput', null, cfg), undefined, 'null: back to the defaults');
});
