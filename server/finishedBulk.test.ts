import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCleanup, type CleanupGuard } from './cleanup.ts';
import { finishedBulkIn, installLeftoverSettings, planInstallLeftovers } from './installLeftovers.ts';
import { planFolders, type CleanupFacts } from './cleanupFolders.ts';
import { readPublished, recordPublished } from './published.ts';

/**
 * w2223: LothDesktop's clean-up (w2219) freed 0 GB of a 60 GB target while about 55 GB sat in four finished workers' folders
 * (ffa-ce01c2ff: w1909's before/after test folders; ffa-a5a28274: copied Unity caches; ffa-d6de1043: a pair leg's checkout;
 * ffa-cc51acac: a revert clone), all held by the 7-day reopen hold. A finished worker's rebuildable bulk now goes; its
 * unpushed work and the evidence it published nowhere else stay, and an open request's folder is not touched.
 */

const HOUR = 3_600_000;
const NOW = Date.now();
const settings = installLeftoverSettings({});
const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=master', ...args], { cwd, stdio: 'pipe' });

function w(base: string, relPath: string, data: string | Buffer = 'x') {
  const p = path.join(base, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

function ageAll(dir: string, ageH: number) {
  const at = (NOW - ageH * HOUR) / 1000;
  const walk = (p: string) => {
    if (fs.lstatSync(p).isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    fs.utimesSync(p, at, at);
  };
  walk(dir);
}

/** A repo to clone from, with one commit and a .gitignore. */
function origin(root: string): string {
  const o = path.join(root, 'origin');
  fs.mkdirSync(o, { recursive: true });
  git(o, 'init', '-q');
  w(o, '.gitignore', '/[Ll]ibrary/\n/out/\n');
  w(o, 'README.md', 'game');
  w(o, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.3');
  git(o, 'add', '.');
  git(o, 'commit', '-q', '-m', 'first');
  return o;
}

/** A finished worker's folder, shaped like the four LothDesktop ones. */
function finishedSession(base: string, from: string) {
  const big = Buffer.alloc(1024 ** 2 + 16);
  // A pushed checkout (ffa-d6de1043's w2093-head): goes whole, its ignored Library with it.
  git(path.dirname(base), 'clone', '-q', from, path.join(base, 'w2093-head'));
  w(base, 'w2093-head/Library/ArtifactDB');
  // A clone whose ignored output holds a screenshot nobody published: it stays, listed.
  git(path.dirname(base), 'clone', '-q', from, path.join(base, 'shotclone'));
  w(base, 'shotclone/out/look.png');
  w(base, 'shotclone/Library/ArtifactDB');
  // A revert clone with a commit on no remote (ffa-cc51acac): it stays, listed; its ignored Library goes.
  git(path.dirname(base), 'clone', '-q', from, path.join(base, 'revert'));
  w(base, 'revert/fix.txt');
  git(path.join(base, 'revert'), 'add', '.');
  git(path.join(base, 'revert'), 'commit', '-q', '-m', 'unpushed');
  w(base, 'revert/Library/ArtifactDB');
  // Copied Unity caches outside a project (ffa-a5a28274).
  w(base, 'peer-cache/Library-copy/ArtifactDB');
  w(base, 'peer-cache/Library-copy/Bee/x');
  w(base, 'peer-cache/Library-copy/ScriptAssemblies/a.dll');
  // Before/after test folders (ffa-ce01c2ff): logs and reports go whole, a folder with an unpublished clip is opened up.
  w(base, 'before/run1/Player.log', big);
  w(base, 'before/run1/results.xml');
  w(base, 'after/run1/Player.log', big);
  w(base, 'after/run1/hover.mp4');
  w(base, 'after/run1/published.png', big);
  w(base, 'after/run2/state.json', big);
  // A player build.
  w(base, 'build/player/UnityPlayer.so');
  w(base, 'build/player/finalfactory_Data/data.unity3d');
  // Loose files: a big log goes, the notes and a small script stay, the Claude task folder is never opened.
  w(base, 'bench.log', big);
  w(base, 'notes.md');
  w(base, 'leg.sh');
  w(base, 'claude-501/tasks/out.log', big);
}

async function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-finished-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const from = origin(path.join(root, 'remote'));
  const tmp = path.join(root, 'tmp');
  const done = path.join(tmp, 'ffa-ce01c2ff');
  const open = path.join(tmp, 'ffa-0bed0bed');
  fs.mkdirSync(tmp, { recursive: true });
  finishedSession(done, from);
  finishedSession(open, from);
  ageAll(tmp, 30);
  // One file was published (after the aging: a record holds the bytes that went).
  const pubFile = path.join(root, 'app', 'published.jsonl');
  recordPublished(pubFile, [path.join(done, 'after', 'run1', 'published.png'), path.join(open, 'after', 'run1', 'published.png')]);
  return { root, tmp, done, open, published: readPublished(pubFile) };
}

/** What goes of the finished folder: a folder holding only a player or a Library copy goes whole as test output. */
const EXPECTED = ['after/run1/Player.log', 'after/run1/published.png', 'after/run2', 'bench.log', 'before', 'build', 'peer-cache', 'revert/Library', 'shotclone/Library', 'w2093-head'].sort();

test("w2223: a finished worker's rebuildable bulk goes; unpushed work, unpublished evidence and an open request's folder stay", async (t) => {
  const { root, tmp, done, open, published } = await fixture(t);
  const guard: CleanupGuard = { keep: [], inUse: [], resumable: [done, open], home: path.join(root, 'home') };
  const p = await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard, procs: [], settings, now: NOW, finished: [done], published });
  const fromDone = p.items.filter((i) => i.inSession === done).map((i) => rel(done, i.path)).sort();
  assert.deepEqual(fromDone, EXPECTED);
  for (const i of p.items.filter((i) => i.rule === 'finished-session-bulk')) assert.match(i.why, /finished worker/);
  // The open request's worker is only resumable: its idle caches go as before (w1719), nothing else.
  const fromOpen = p.items.filter((i) => within(i.path, open)).map((i) => rel(open, i.path)).sort();
  assert.deepEqual(fromOpen, ['build/player', 'revert/Library', 'shotclone/Library', 'w2093-head/Library']);
  assert.ok(p.items.every((i) => i.rule !== 'finished-session-bulk' || within(i.path, done)));
  // The clones that stay are listed for a person, with why.
  const listed = new Map(p.listed.map((l) => [rel(done, l.path), l.why]));
  assert.match(listed.get('revert') ?? '', /work on no remote/);
  assert.match(listed.get('shotclone') ?? '', /published nowhere else.*out[\\/]look\.png/); // path.relative: out\look.png on Windows
  // And they go: the folder, the unpushed clone, the clip and the notes are still there.
  const run = await runCleanup(p.items.filter((i) => within(i.path, done)), guard);
  assert.deepEqual(run.failed, []);
  for (const keep of ['revert/fix.txt', 'shotclone/out/look.png', 'after/run1/hover.mp4', 'notes.md', 'leg.sh', 'claude-501/tasks/out.log']) assert.ok(fs.existsSync(path.join(done, keep)), keep);
  for (const gone of EXPECTED) assert.ok(!fs.existsSync(path.join(done, gone)), gone);
});

test('w2223: a finished worker written within the day keeps its bulk, unless disk is low and 15 min have passed', async (t) => {
  const { root, tmp, done, published } = await fixture(t);
  w(done, 'after/run3/late.log');
  const late = (NOW - 1 * HOUR) / 1000;
  for (const p of ['after/run3/late.log', 'after/run3', 'after', '.']) fs.utimesSync(path.join(done, p), late, late);
  const guard: CleanupGuard = { keep: [], inUse: [], resumable: [done], home: path.join(root, 'home') };
  const calm = await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard, procs: [], settings, now: NOW, finished: [done], published });
  assert.deepEqual(calm.items.filter((i) => i.rule === 'finished-session-bulk'), []);
  const low = await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard, procs: [], settings, now: NOW, finished: [done], published, low: true });
  const taken = low.items.filter((i) => i.inSession === done).map((i) => rel(done, i.path)).sort();
  assert.deepEqual(taken, [...EXPECTED, 'after/run3'].sort());
  // A process naming the folder still holds it.
  const named = await planInstallLeftovers({ root, sandboxes: [], tempRoots: [tmp], guard, procs: [{ pid: 9, ppid: 1, cmd: `node ${done}/x.js` }], settings, now: NOW, finished: [done], published, low: true });
  assert.deepEqual(named.items.filter((i) => i.rule === 'finished-session-bulk'), []);
});

test('w2223: ff-leftovers folders lists a finished worker\'s bulk as DELETE inside its kept folder, never an open one\'s', async (t) => {
  const { root, tmp, done, open, published } = await fixture(t);
  const facts: CleanupFacts = {
    at: new Date(NOW).toISOString(),
    connected: true,
    root,
    tempRoot: tmp,
    sandboxes: [],
    live: [],
    resumable: ['ce01c2ff', '0bed0bed'],
    owners: { '0bed0bed': { requests: [{ id: 'w2135', status: 'active', with: true }] } } as CleanupFacts['owners'],
    open: ['w2135'],
    closed: ['w1909'],
    contextAt: new Date(NOW).toISOString(),
  };
  const rows = await planFolders(facts, { now: NOW, sizes: 'none', published });
  const del = rows.filter((r) => r.verdict === 'delete').map((r) => rel(done, r.path)).sort();
  assert.deepEqual(del, EXPECTED);
  assert.ok(rows.some((r) => r.path === done && r.verdict === 'keep'));
  assert.ok(rows.some((r) => r.path === open && r.verdict === 'keep'));
  assert.ok(!rows.some((r) => within(r.path, open) && r.path !== open));
  assert.ok(rows.some((r) => rel(done, r.path) === 'revert' && r.verdict === 'keep' && /work on no remote/.test(r.why)));
});

test('w2223: finishedBulkIn keeps evidence and takes it once published', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-evidence-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const s = path.join(root, 'ffa-1');
  const shot = w(s, 'look/frame.png', Buffer.alloc(1024 ** 2 + 1));
  w(s, 'look/run.log');
  const before = await finishedBulkIn(s, {});
  assert.deepEqual(before.take, []);
  assert.ok(before.keep.some((k) => /published nowhere else/.test(k.why)));
  const pub = path.join(root, 'published.jsonl');
  recordPublished(pub, [shot]);
  const after = await finishedBulkIn(s, { published: readPublished(pub) });
  assert.deepEqual(after.take.map((x) => rel(s, x.path)), ['look']);
  // Edited after it was published: no longer the bytes that went, so it stays.
  fs.appendFileSync(shot, 'y');
  const edited = await finishedBulkIn(s, { published: readPublished(pub) });
  assert.deepEqual(edited.take, []);
});

function within(p: string, dir: string) {
  const r = path.relative(dir, p);
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
}

/**
 * w2796: LothDesktop's clean-up (w2795) reached about 24 GB free of a 30 GB goal while the reopen hold kept finished workers'
 * per-run folders: ffa-f6caa21c's tour* (clip-medium, -strong, -subtle: 3,179 to 4,096 JPGs each), ffa-8802c424's audit-*
 * (resize-1920/clip-reopen: 1,047 JPGs) and ffa-631ef092's before-/after-client (frames-host: 5,450 JPGs and a CSV). Each frame
 * counted as unpublished evidence, so the whole run stayed. The frames go now; the stills, clips and notes beside them stay.
 */
test("w2796: a finished worker's per-run folders lose their capture frames; their unpublished stills, clips and notes stay", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-frames-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const s = path.join(root, 'ffa-f6caa21c');
  const frames = (dir: string, n: number, ext = 'jpg') => {
    for (let i = 0; i < n; i++) w(s, `${dir}/${String(i).padStart(6, '0')}.${ext}`);
  };
  // A tour: three frame folders with an ffmpeg list each, and the stills a person looks at beside them.
  for (const c of ['clip-medium', 'clip-strong', 'clip-subtle']) {
    frames(`tour-130032/${c}`, 120);
    w(s, `tour-130032/${c}/list.txt`);
  }
  w(s, 'tour-130032/0-idle.png');
  w(s, 'tour-130032/0-idle.json');
  // An audit: frames two levels down, and its notes.
  frames('audit-after-171748/resize-1920/clip-reopen', 150);
  w(s, 'audit-after-171748/resize-1920.out');
  w(s, 'audit-after-171748/notes.md');
  // A before/after leg with only frames, a CSV and logs: it goes whole.
  frames('after-client-200639/frames-host', 110);
  w(s, 'after-client-200639/frames-host/timing.csv');
  w(s, 'after-client-200639/host.log');
  // Not frames: a set of stills, a frame folder with its clip beside it, and a folder under the threshold.
  frames('census-after4/1920', 12, 'png');
  frames('final-111027', 130, 'png');
  w(s, 'final-111027/subtle.mp4');
  frames('crit', 99);

  const got = await finishedBulkIn(s, {});
  assert.deepEqual(got.take.map((x) => rel(s, x.path)).sort(), [
    'after-client-200639',
    'audit-after-171748/resize-1920',
    'tour-130032/clip-medium',
    'tour-130032/clip-strong',
    'tour-130032/clip-subtle',
  ]);
  assert.ok(got.take.filter((x) => x.path.includes('tour-')).every((x) => /a capture's frames \(120 images/.test(x.what)));
  // The stills, the clip with its frames, the notes and the short folder are evidence published nowhere else: they stay.
  assert.ok(got.keep.some((k) => k.path === s && /published nowhere else/.test(k.why)));
  assert.ok(!got.take.some((x) => /census|final-111027|crit|0-idle|notes\.md/.test(x.path)));
});
