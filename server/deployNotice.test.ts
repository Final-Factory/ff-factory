import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEPLOY_NOTICE_FILE, DeployNotice, doneLine, estimateMinutes, minutesText, prsInRelease, startLine, type RestartSample } from './deployNotice.ts';
import { Drainer, type RestartRequest, type SessionSnapshot } from './restart.ts';

/** w5887: a deploy or restart tells every active orchestrator it starts, and that it is done. */

const T0 = Date.parse('2026-11-26T04:00:00Z');
const MIN = 60_000;
const UPDATE: RestartRequest = { drain: 'auto', drainMinutes: 30, reason: 'update to 1a2b3c4d5 (auto-deploy: #1290, #1293)', update: true, hold: false, auto: true };

function world(t: TestContext, over: { ids?: string[]; noteThrows?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-deploynotice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = { dir, now: T0, ids: over.ids ?? ['loth-orch', 'ben-orch', 'dispatcher'], notes: [] as [string, string][], lines: [] as string[] };
  const make = () =>
    new DeployNotice({
      dataDir: dir,
      orchestrators: () => w.ids,
      note: (id, text) => {
        if (over.noteThrows && id === 'ben-orch') throw new Error('gone');
        w.notes.push([id, text]);
      },
      log: (l) => void w.lines.push(l),
      now: () => w.now,
    });
  return { w, make };
}

const sample = (downMin: number, update = true, i = 0): RestartSample => ({
  stoppedAt: new Date(T0 - (i + 1) * 60 * MIN).toISOString(),
  upAt: new Date(T0 - (i + 1) * 60 * MIN + downMin * MIN).toISOString(),
  update,
});

test('estimate: the median of the recent measured downtimes, rounded up; an update prefers update samples', () => {
  assert.equal(estimateMinutes([], true), undefined, 'no sample, no number');
  assert.deepEqual(estimateMinutes([sample(1.2), sample(2.5, true, 1), sample(1.8, true, 2)], true), { minutes: 2, n: 3 });
  assert.deepEqual(estimateMinutes([sample(1.2), sample(2.6, true, 1)], true), { minutes: 2, n: 2 }, 'even count: the mean of the middle two (1.9)');
  // Three plain restarts of 0.5 min and three updates of 3 min: each kind reads its own.
  const mixed = [sample(0.5, false), sample(0.5, false, 1), sample(0.5, false, 2), sample(3, true, 3), sample(3, true, 4), sample(3, true, 5)];
  assert.deepEqual(estimateMinutes(mixed, true), { minutes: 3, n: 3 });
  assert.deepEqual(estimateMinutes(mixed, false), { minutes: 1, n: 3 }, 'never under a minute');
  assert.deepEqual(estimateMinutes([sample(2, false)], true), { minutes: 2, n: 1 }, 'fewer than three of its kind: every sample');
  assert.equal(estimateMinutes(Array.from({ length: 20 }, (_, i) => sample(i < 10 ? 2 : 9, true, i)), true)?.minutes, 2, 'only the last ten');
});

test('the lines: what goes out, the measured estimate, how long it took', () => {
  const p = { update: true, to: '1a2b3c4d5e6f', prs: [{ number: 1290, title: 'Deploy notices' }, { number: 1293 }], reason: 'update' };
  assert.equal(
    startLine(p, { minutes: 3, n: 7 }),
    "[portal] Portal update starting: deploying 1a2b3c4d5 (#1290 Deploy notices, #1293). I'll be unresponsive for about 3 minutes (the median of the last 7 restarts, measured).",
  );
  assert.match(startLine({ update: false, reason: 'restart (fffctl)' }, undefined), /Portal restart starting: restarting \(restart \(fffctl\)\)\. I'll be unresponsive for a few minutes \(no restart of this portal measured yet\)/);
  assert.equal(
    doneLine({ update: true, startedAt: new Date(T0).toISOString() }, { running: '1a2b3c4d5', upAt: T0 + 2.5 * MIN, stoppedAt: new Date(T0 + 1 * MIN).toISOString() }),
    '[portal] Portal update done: now on 1a2b3c4d5, took 2.5 min since the start line, down 1.5 min.',
  );
  assert.equal(minutesText(40_000), 'under a minute');
  assert.equal(minutesText(14 * MIN), '14 min');
});

test('a deploy: the start line to every active orchestrator, the stop and the next start measured, the done line', (t) => {
  const { w, make } = world(t);
  const a = make();
  a.started(UPDATE, { from: '0f0f0f0f0', prs: [{ number: 1290, title: 'Deploy notices' }] });
  assert.deepEqual(w.notes.map(([id]) => id), ['loth-orch', 'ben-orch', 'dispatcher']);
  assert.match(w.notes[0][1], /^\[portal\] Portal update starting: deploying 1a2b3c4d5 \(#1290 Deploy notices\)\. I'll be unresponsive for a few minutes/, 'the target from the reason fff-update writes');
  w.now += 40_000;
  a.stopping();
  // The next server: a new process reads the same file.
  w.now += 100_000;
  w.notes.length = 0;
  const b = make();
  b.booted({ running: '1a2b3c4d5', resumeAt: new Date(T0).toISOString(), update: true });
  assert.deepEqual(w.notes.map(([id]) => id), ['loth-orch', 'ben-orch', 'dispatcher']);
  assert.equal(w.notes[0][1], '[portal] Portal update done: now on 1a2b3c4d5, took 2.3 min since the start line, down 1.7 min.');
  assert.equal(b.state.pending, undefined);
  assert.equal(b.state.samples.length, 1);
  assert.equal(b.state.samples[0].stoppedAt, new Date(T0 + 40_000).toISOString(), "the stop this server recorded beats the resume file's");
  // The next deploy's estimate is that measured downtime.
  w.notes.length = 0;
  b.started(UPDATE);
  assert.match(w.notes[0][1], /about 2 minutes \(the median of the last 1 restart, measured\)/);
  assert.ok(fs.existsSync(path.join(w.dir, DEPLOY_NOTICE_FILE)));
});

test('the deploy that ships this: no start line from the old server, but its downtime is still a sample (resume file)', (t) => {
  const { w, make } = world(t);
  w.now = T0 + 90_000;
  const b = make();
  b.booted({ running: 'abc', resumeAt: new Date(T0).toISOString(), update: true });
  assert.deepEqual(w.notes, [], 'no done line without a start line');
  assert.equal(estimateMinutes(b.state.samples, true)?.minutes, 2);
});

test('an update that did not take says so; a stale start is not reported done', (t) => {
  const { w, make } = world(t);
  const a = make();
  a.started(UPDATE);
  w.now += 3 * MIN;
  w.notes.length = 0;
  make().booted({ running: '0f0f0f0f0' });
  assert.match(w.notes[0][1], /now on 0f0f0f0f0.*It was to deploy 1a2b3c4d5: the update did not take/);
  make().started(UPDATE);
  w.now += 7 * 60 * MIN;
  w.notes.length = 0;
  make().booted({ running: '1a2b3c4d5' });
  assert.deepEqual(w.notes, []);
  assert.match(w.lines.at(-1)!, /too old to report done/);
});

test('a notice never throws: a chat that refuses, a list that throws, a data folder it cannot write', (t) => {
  const { w, make } = world(t, { noteThrows: true });
  const a = make();
  a.started(UPDATE);
  assert.deepEqual(w.notes.map(([id]) => id), ['loth-orch', 'dispatcher'], 'the others are still told');
  assert.match(w.lines.join('\n'), /could not tell ben-orch: gone/);
  const broken = new DeployNotice({ dataDir: path.join(w.dir, 'missing', 'deeper'), orchestrators: () => { throw new Error('no store'); }, note: () => undefined, log: () => undefined });
  broken.started(UPDATE);
  broken.stopping();
  broken.cancelled('x');
  broken.booted({ running: 'x' });
});

test('the drain: a cancelled restart is said; a second request does not count as a new one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-deploynotice-drain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cancelled: string[] = [];
  const stops: string[] = [];
  const busy: SessionSnapshot = { id: 'a', kind: 'worker', title: 'a', sandboxId: 'sb1', status: 'running', unanswered: [], lastFrom: 'orchestrator' };
  const d = new Drainer({
    dataDir: dir,
    snapshot: () => [busy],
    tell: () => undefined,
    stop: (req) => void stops.push(req.reason),
    changed: () => undefined,
    log: () => undefined,
    cancelled: (why) => {
      cancelled.push(why);
      throw new Error('a notice that throws');
    },
  });
  assert.equal(d.requested, undefined);
  d.request({ ...UPDATE, hold: true });
  assert.equal((d.requested as RestartRequest | undefined)?.reason, UPDATE.reason, 'taken');
  assert.match(d.request(UPDATE), /already pending/);
  busy.status = 'idle';
  t.mock.timers.tick(3000);
  t.mock.timers.tick(5 * 60_000 + 3000);
  assert.equal(cancelled.length, 1, 'the hold timed out: the restart did not happen');
  assert.equal(d.requested, undefined);
  // A throwing notice changed nothing: the next restart goes through.
  d.request({ ...UPDATE, hold: false });
  t.mock.timers.tick(5000);
  assert.deepEqual(stops, [UPDATE.reason]);
});

test('the pull requests a prepared release brings, from its merge commits', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-deploynotice-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const from = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', 'side');
  git('commit', '-q', '--allow-empty', '-m', 'work');
  git('switch', '-q', 'main');
  git('merge', '-q', '--no-ff', 'side', '-m', 'Merge pull request #1300 from Final-Factory/side\n\nDeploy notices');
  const to = git('rev-parse', 'HEAD');
  assert.deepEqual(prsInRelease(dir, from, to), [{ number: 1300, title: 'Deploy notices' }]);
  assert.throws(() => prsInRelease(dir, 'nope', to), 'the caller catches it');
});
