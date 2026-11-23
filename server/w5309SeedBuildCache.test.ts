import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeWithGit, planFolders, type CleanupFacts, type SlotContext } from './cleanupFolders.ts';

const DAY = 86_400_000;
const MIN = 60_000;

function file(p: string, writtenDaysAgo: number, bytes?: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (bytes === undefined) fs.writeFileSync(p, 'x'.repeat(64));
  else {
    // A sparse file: the 2 GB BuildCache cap is passed without writing gigabytes.
    const fd = fs.openSync(p, 'w');
    fs.ftruncateSync(fd, bytes);
    fs.closeSync(fd);
  }
  const t = (Date.now() - writtenDaysAgo * DAY) / 1000;
  fs.utimesSync(p, t, t);
}

/** An install with a seed/Library whose BuildCache holds the newest build's entry and an old 3 GB one past the cap. */
function seedWorld(t: { after: (fn: () => void) => void }, factsAt: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w5309-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, 'seed', 'Library');
  const newest = path.join(seed, 'BuildCache', 'aa', 'h1', 'v1');
  file(path.join(newest, 'x.info'), 1);
  const old = path.join(seed, 'BuildCache', 'bb', 'h2', 'v1');
  file(path.join(old, 'blob'), 20, 3 * 1024 ** 3);
  file(path.join(old, 'blob.info'), 20);
  const facts: CleanupFacts = {
    at: new Date(factsAt).toISOString(),
    connected: true,
    root,
    tempRoot: path.join(root, 'tmp'),
    sandboxes: [],
    live: [],
    resumable: [],
    owners: {},
    open: [],
    closed: [],
    contextAt: new Date(factsAt).toISOString(),
  };
  const ctx: SlotContext = { host: 'test', alive: () => false, procs: [] };
  return { seed, newest, old, facts, ctx };
}

test('w5309: a folders run judges the seed\'s old BuildCache entries on its own clock, so a long run still lists them DELETE', async (t) => {
  // m5, 2026-11-23: the facts were 7 s old when `folders` began; by the BuildCache rows the wall clock put them past 5 min, the
  // seed rule stood aside and all 451 rows came out "not a place with an owner in the ledger". Here: facts 6 min old by the wall
  // clock, 10 s old by the run's clock.
  const factsAt = Date.now() - 6 * MIN;
  const { old, newest, facts, ctx } = seedWorld(t, factsAt);
  const rows = (await planFolders(facts, { now: factsAt + 10_000, slots: ctx, sizes: 'none' })).filter((r) => r.path.includes('BuildCache'));
  assert.deepEqual(rows.map((r) => [r.path, r.kind, r.verdict]), [[old, 'seed-library', 'delete']], JSON.stringify(rows));
  assert.match(rows[0]!.why, /a stale entry of the Library seed's BuildCache: a build-cache entry older than the newest build/);
  assert.equal((await judgeWithGit(newest, facts, factsAt + 10_000, ctx)).verdict, 'keep');
});

test('w5309: a file inside a stale BuildCache entry is KEEP: only the whole entry goes (w1211)', async (t) => {
  const { old, facts, ctx } = seedWorld(t, Date.now() + 1000);
  assert.equal((await judgeWithGit(old, facts, Date.now(), ctx)).verdict, 'delete');
  for (const part of [path.join(old, 'blob'), path.join(old, 'blob.info')]) {
    const r = await judgeWithGit(part, facts, Date.now(), ctx);
    assert.equal(r.verdict, 'keep', part);
    assert.match(r.why, /part of a stale BuildCache entry .*only the whole entry goes/);
  }
});

test('w5309: an idle sandbox\'s BuildCache entry goes whole too', async (t) => {
  const { facts, ctx } = seedWorld(t, Date.now() + 1000);
  const sb = path.join(facts.root!, 'sandboxes', 'slot1');
  const old = path.join(sb, 'Library', 'BuildCache', 'cc', 'h3', 'v1');
  file(path.join(sb, 'Library', 'BuildCache', 'dd', 'h4', 'v1', 'x.info'), 1);
  file(path.join(old, 'blob'), 20, 3 * 1024 ** 3);
  const f = { ...facts, sandboxes: [{ id: 'slot1', path: sb }] };
  assert.equal((await judgeWithGit(old, f, Date.now(), ctx)).verdict, 'delete');
  const part = await judgeWithGit(path.join(old, 'blob'), f, Date.now(), ctx);
  assert.equal(part.verdict, 'keep');
  assert.match(part.why, /only the whole entry goes/);
});
