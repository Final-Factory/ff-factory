import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clashGates, clashLine, expectedFiles, ffuClashes, ffuStartClashes, FfuPrReads, filesNamed, hubFilesOf, MAX_NAMED, prRequest, sameFile, type FfuPr } from './ffuOverlap.ts';
import type { WorkItem } from '../shared/types.ts';

/** w4553: two ffu rows that edit the same code do not run at once (server/ffuOverlap.ts). */

const NOW = Date.parse('2026-11-16T08:00:00Z');
const HUBS = ['crates/ffu-sim/src/sector.rs', 'crates/ffu-sim/src/snapshot.rs', 'crates/ffu-ui/src/hud.rs', 'crates/ffu-client/src/main.rs'];

const row = (id: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({ id, title: `row ${id}`, brief: '', status: 'active', sessionIds: ['s-' + id], repo: 'Final-Factory/ffu', keys: [], log: [], overlaps: [], requesters: [], ...over }) as unknown as WorkItem;

// The briefs of two real rows (2026-11-16), as filed.
const W4418 =
  'w4280 (ffu PR #829) binds Frenzy, Guardian and Obliterator Disk to F, H and J in crates/ffu-platform/src/lib.rs (Ability(2..4)), keyboard only. Add pad bindings ... show the pad glyphs in the tray prompts (crates/ffu-ui/src/hud.rs tray_tile) when a pad is in use.';
const W4376 = 'Repair (sector/repair.rs:2-24) and regen (sector.rs:298, :2552) heal grid members through M1.38\'s path. Build: unify #822\'s structure health.';

test('w4553: the paths a brief names, with line suffixes dropped and links left out', () => {
  assert.deepEqual(filesNamed(W4418), ['crates/ffu-platform/src/lib.rs', 'crates/ffu-ui/src/hud.rs']);
  assert.deepEqual(filesNamed(W4376), ['sector/repair.rs', 'sector.rs']);
  assert.deepEqual(filesNamed('see https://github.com/Final-Factory/ffu/blob/main/docs/play.md and `docs/oracle/w4373.md` rows, ff1power.rs `storage_rates`'), ['docs/oracle/w4373.md', 'ff1power.rs']);
  assert.deepEqual(filesNamed('Build it in crates/ffu-sim/src/sector/structures.rs. Then docs/play.md, done'), ['crates/ffu-sim/src/sector/structures.rs', 'docs/play.md']);
  assert.deepEqual(filesNamed('version 1.0.0.9, the w4548 fix, e.g. a sentence.'), []);
});

test('w4553: one file is a path or its tail at a slash; a bare lib.rs or main.rs names no file', () => {
  assert.ok(sameFile('sector/tech.rs', 'crates/ffu-sim/src/sector/tech.rs'));
  assert.ok(sameFile('ff1power.rs', 'crates/ffu-sim/src/ff1power.rs'));
  assert.ok(sameFile('crates/ffu-platform/src/lib.rs', 'crates/ffu-platform/src/lib.rs'));
  assert.ok(!sameFile('lib.rs', 'crates/ffu-platform/src/lib.rs'));
  assert.ok(!sameFile('tech.rs', 'crates/ffu-sim/src/sector/biotech.rs'));
  assert.ok(!sameFile('sector/tech.rs', 'crates/ffu-sim/src/snapshot/tech.rs'));
});

test('w4553: hubs are the files a tenth of the recent merged PRs touch, and need a sample of 20', () => {
  const merged = Array.from({ length: 30 }, (_, i) => ['crates/ffu-sim/src/sector.rs', ...(i < 3 ? ['crates/ffu-sim/src/ff1power.rs'] : []), ...(i < 2 ? ['docs/play.md'] : []), `crates/x/f${i}.rs`]);
  assert.deepEqual(hubFilesOf(merged), ['crates/ffu-sim/src/ff1power.rs', 'crates/ffu-sim/src/sector.rs']);
  assert.deepEqual(hubFilesOf(merged.slice(0, 10)), []);
});

test('w4553: a row expects what it declares and what its brief names, hubs out; a plan-sized brief predicts nothing', () => {
  assert.deepEqual(expectedFiles(undefined, W4376, HUBS), ['sector/repair.rs']);
  assert.deepEqual(expectedFiles(['crates/ffu-sim/src/sector/repair.rs'], W4376, HUBS), ['crates/ffu-sim/src/sector/repair.rs']);
  const plan = Array.from({ length: MAX_NAMED + 1 }, (_, i) => `crates/m/f${i}.rs`).join(', ');
  assert.deepEqual(expectedFiles(undefined, plan, HUBS), []);
  assert.deepEqual(expectedFiles(['docs/play.md'], plan, HUBS), ['docs/play.md']);
});

test('w4553: a PR is for the request its Request or Part of line names, else its wNNN- branch', () => {
  assert.equal(prRequest({ body: 'Fixes it.\n\nRequest: w4376\n' }), 'w4376');
  assert.equal(prRequest({ body: 'Part of: W4553' }), 'w4553');
  assert.equal(prRequest({ body: '', headRefName: 'w4431-docked-draw' }), 'w4431');
  assert.equal(prRequest({ body: 'no line', headRefName: 'main-fix' }), undefined);
});

// ffu#852 (w4370), opened while w4418 was in flight: the pad layer in the same file and the same docs rows (w4548).
const PR852: FfuPr = { number: 852, body: 'Request: w4370', updatedAt: '2026-11-16T08:35:00Z', files: ['crates/ffu-platform/src/lib.rs', 'docs/play.md', 'crates/ffu-ui/src/hud.rs'] };

test('w4553: w4418 against w4370 in flight: held on ffu#852 for ffu-platform/src/lib.rs, not for the hub hud.rs', () => {
  const clashes = ffuClashes({ id: 'w4418', mine: expectedFiles(undefined, W4418, HUBS), prs: [PR852], rows: [{ id: 'w4370', files: [], prs: [852] }], hubs: HUBS, now: NOW });
  assert.deepEqual(clashes, [{ id: 'w4370', pr: 852, files: ['crates/ffu-platform/src/lib.rs'] }]);
  assert.equal(clashLine(clashes[0]), 'Final-Factory/ffu#852 (w4370): crates/ffu-platform/src/lib.rs');
  assert.deepEqual(clashGates(clashes), [{ kind: 'pr', ref: 'Final-Factory/ffu#852', what: 'Final-Factory/ffu#852 to merge: it edits crates/ffu-platform/src/lib.rs too (w4553)' }]);
});

test('w4553: rows of one fan-out started together clash before either has a PR: the later waits on the request', () => {
  const clashes = ffuClashes({ id: 'w4376', mine: ['sector/structures.rs'], prs: [], rows: [{ id: 'w4377', files: ['crates/ffu-sim/src/sector/structures.rs'], prs: [] }], hubs: HUBS, now: NOW });
  assert.deepEqual(clashes, [{ id: 'w4377', files: ['sector/structures.rs'] }]);
  assert.deepEqual(clashGates(clashes), [{ kind: 'request', ref: 'w4377', what: 'w4377 to close: its row edits sector/structures.rs too (w4553)' }]);
});

test('w4553: no hold on a hub, a parked PR, its own PR, or a row on other files', () => {
  const parked: FfuPr = { number: 136, body: 'Request: w2895', updatedAt: '2026-11-04T06:21:00Z', files: ['crates/ffu-sim/src/sector/tech.rs'] };
  const own: FfuPr = { number: 900, body: 'Request: w4375', updatedAt: '2026-11-16T07:00:00Z', files: ['crates/ffu-sim/src/sector/tech.rs'] };
  const hub: FfuPr = { number: 901, body: 'Request: w4390', updatedAt: '2026-11-16T07:00:00Z', files: ['crates/ffu-sim/src/sector.rs', 'crates/ffu-sim/src/sector/mining.rs'] };
  const clashes = ffuClashes({ id: 'w4375', mine: ['sector/tech.rs', 'crates/ffu-sim/src/sector.rs'], prs: [parked, own, hub], rows: [{ id: 'w4391', files: ['sector/rewards.rs'], prs: [] }], hubs: HUBS, now: NOW });
  assert.deepEqual(clashes, []);
  assert.deepEqual(ffuClashes({ id: 'w1', mine: [], prs: [hub], rows: [], hubs: HUBS, now: NOW }), []);
});

test('w4553: an open PR no row in flight owns still holds a row on its files', () => {
  const pr: FfuPr = { number: 869, body: 'Request: w4492', updatedAt: '2026-11-16T07:10:00Z', files: ['crates/ffu-sim/src/ff1power.rs'] };
  assert.deepEqual(ffuClashes({ id: 'w4507', mine: ['ff1power.rs'], prs: [pr], rows: [], hubs: HUBS, now: NOW }), [{ id: 'w4492', pr: 869, files: ['ff1power.rs'] }]);
});

test('w4553: the start check reads the ledger: ffu rows a worker started, open; not game work, not a row with its own PR', () => {
  const work = [
    row('w4377', { brief: 'Build: sight scan in crates/ffu-sim/src/sector/structures.rs.' }),
    row('w4378', { brief: 'Also sector/structures.rs.', status: 'done' } as Partial<WorkItem>),
    row('w4379', { brief: 'sector/structures.rs', sessionIds: [] }),
    row('w4380', { brief: 'sector/structures.rs', repo: 'Final-Factory/FinalFactory' }),
    row('w4381', { ffuFiles: ['crates/ffu-sim/src/sector/structures.rs'] }),
  ];
  const w = row('w4376', { brief: 'Unify building health in sector/structures.rs and sector.rs.', sessionIds: [] });
  const got = ffuStartClashes({ w, prompt: 'Go.', work, prs: [], hubs: HUBS, now: NOW });
  assert.deepEqual(got.mine, ['sector/structures.rs']);
  assert.deepEqual(got.clashes.map((c) => c.id), ['w4377', 'w4381']);
  assert.deepEqual(ffuStartClashes({ w: { ...w, repo: 'Final-Factory/FinalFactory' }, prompt: '', work, prs: [], hubs: HUBS, now: NOW }).clashes, []);
  const withPr = { ...w, prs: [{ repo: 'Final-Factory/ffu', number: 841, state: 'open' as const }] } as WorkItem;
  assert.deepEqual(ffuStartClashes({ w: withPr, prompt: '', work, prs: [], hubs: HUBS, now: NOW }).clashes, []);
  // The dispatcher's declared files and the start prompt count too.
  const quiet = row('w4400', { brief: 'Tech rewards.', sessionIds: [] });
  assert.deepEqual(ffuStartClashes({ w: quiet, declared: ['crates/ffu-sim/src/sector/structures.rs'], prompt: '', work, prs: [], hubs: HUBS, now: NOW }).clashes.length, 2);
  assert.deepEqual(ffuStartClashes({ w: quiet, prompt: 'Edit sector/structures.rs.', work, prs: [], hubs: HUBS, now: NOW }).clashes.length, 2);
});

test('w4553: the gh reads are cached, a minute for open PRs and an hour for the hubs', async () => {
  let now = NOW;
  const calls: string[][] = [];
  const run = async (_cmd: string, args: string[]) => {
    calls.push(args);
    const merged = args.includes('merged');
    const out = merged ? Array.from({ length: 20 }, () => ({ files: [{ path: 'crates/ffu-sim/src/sector.rs' }] })) : [{ number: 5, body: 'Request: w9', updatedAt: '2026-11-16T07:00:00Z', headRefName: 'w9-x', files: [{ path: 'a/b.rs' }] }];
    return { code: 0, stdout: JSON.stringify(out), stderr: '' };
  };
  const reads = new FfuPrReads(() => now);
  assert.deepEqual(await reads.openPrs(run), [{ number: 5, body: 'Request: w9', updatedAt: '2026-11-16T07:00:00Z', headRefName: 'w9-x', files: ['a/b.rs'] }]);
  assert.deepEqual(await reads.hubs(run), ['crates/ffu-sim/src/sector.rs']);
  now += 30_000;
  await reads.openPrs(run);
  await reads.hubs(run);
  assert.equal(calls.length, 2);
  now += 60_000;
  await reads.openPrs(run);
  await reads.hubs(run);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].slice(0, 4), ['pr', 'list', '-R', 'Final-Factory/ffu']);
  const failing = async () => ({ code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials\nmore' });
  await assert.rejects(new FfuPrReads(() => now).openPrs(failing), /gh pr list -R Final-Factory\/ffu: HTTP 401: Bad credentials$/);
});
