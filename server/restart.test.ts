import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DRAIN_TAG,
  Drainer,
  RELOCATE_RESULT_FILE,
  collectResume,
  drainMessage,
  orchestratorWasBusy,
  parseRestartRequest,
  readUpdateResult,
  restartSummary,
  versionLine,
  resumeMessage,
  systemdSupervised,
  takeResumeFile,
  updateLogHint,
  writeResumeFile,
  writeUpdateWanted,
  type RelocateOutcome,
  type RestartRequest,
  type ResumeFile,
  type SessionSnapshot,
} from './restart.ts';

const snap = (s: Partial<SessionSnapshot> & { id: string }): SessionSnapshot => ({
  kind: 'worker',
  title: s.id,
  sandboxId: 'sb1',
  status: 'idle',
  unanswered: [],
  lastFrom: 'orchestrator',
  ...s,
});

test('resume list: mid-turn, queued and drained workers; idle ones stay idle', () => {
  const list = collectResume(
    [
      snap({ id: 'busy', status: 'running' }),
      snap({ id: 'perm', status: 'waiting_permission' }),
      snap({ id: 'boot', status: 'starting' }),
      snap({ id: 'queued', status: 'stopped', unanswered: [{ text: 'do X next', from: 'orchestrator' }] }),
      snap({ id: 'paused', status: 'idle' }),
      snap({ id: 'idle', status: 'idle' }),
      snap({ id: 'stopped', status: 'stopped' }),
      snap({ id: 'err', status: 'error' }),
    ],
    new Set(['paused']),
  );
  assert.deepEqual(
    list.map((e) => [e.id, e.why]),
    [
      ['busy', 'mid-turn'],
      ['perm', 'mid-turn'],
      ['boot', 'mid-turn'],
      ['queued', 'queued'],
      ['paused', 'drained'],
    ],
  );
  assert.deepEqual(list.find((e) => e.id === 'queued')?.unanswered, [{ text: 'do X next', from: 'orchestrator' }]);
});

test('resume list: the orchestrator and standing agents are never on it', () => {
  const list = collectResume([snap({ id: 'o', kind: 'orchestrator', status: 'running' }), snap({ id: 's', kind: 'standing', status: 'running' })], new Set(['o', 's']));
  assert.deepEqual(list, []);
  assert.equal(orchestratorWasBusy([snap({ id: 'o', kind: 'orchestrator', status: 'running' })]), true);
  assert.equal(orchestratorWasBusy([snap({ id: 'o', kind: 'orchestrator', status: 'idle' })]), false);
  assert.equal(orchestratorWasBusy([snap({ id: 'o', kind: 'orchestrator', status: 'stopped', unanswered: [{ text: 'hi', from: 'human' }] })]), true);
});

test('resume list: the drain request itself is not work to resume', () => {
  const drain = { text: `${DRAIN_TAG} FF Factory will restart…`, from: 'system' as const };
  // Wrapped up and went idle: resumed only because it was drained, with no stale messages.
  const [e] = collectResume([snap({ id: 'a', status: 'idle', unanswered: [drain] })], new Set(['a']));
  assert.deepEqual([e.why, e.unanswered], ['drained', []]);
  // Not drained, only the drain message outstanding: nothing to resume.
  assert.deepEqual(collectResume([snap({ id: 'b', status: 'idle', unanswered: [drain] })]), []);
  // Still busy at the deadline: resumed, the task kept, the drain message dropped.
  const [c] = collectResume([snap({ id: 'c', status: 'running', unanswered: [{ text: 'build it', from: 'orchestrator' }, drain] })], new Set(['c']));
  assert.deepEqual(c.unanswered, [{ text: 'build it', from: 'orchestrator' }]);
});

test('resume message: what happened, what to check, and the unanswered messages', () => {
  const f = { reason: 'update (request_app_update)', at: '2026-09-23T18:00:00Z' };
  const m = resumeMessage({ id: 'a', kind: 'worker', title: 'a', why: 'mid-turn', unanswered: [{ text: 'build\n  it', from: 'orchestrator' }], lastFrom: 'orchestrator' }, f);
  assert.match(m, /^The app restarted \(update \(request_app_update\) at /);
  // Not on a machine: an orchestrator, the only agent the portal runs itself (w510): no worktree, no editor.
  assert.match(m, /Your process was stopped; your history is intact\./);
  assert.match(m, /Continue where you left off\./);
  assert.doesNotMatch(m, /Unity|git status/);
  assert.match(m, /cut off/);
  assert.match(m, /- \(from the orchestrator, for no named person\) build it$/m);
  const d = resumeMessage({ id: 'a', kind: 'worker', title: 'a', why: 'drained', unanswered: [], lastFrom: 'human' }, f);
  assert.match(d, /asked to pause/);
  assert.doesNotMatch(d, /not answered/);
  // A session on one of the user's Macs has no managed Unity editor to re-pin.
  const [onMac] = collectResume([snap({ id: 'mac', sandboxId: undefined, machineId: 'm5', status: 'running' })]);
  assert.equal(onMac.machineId, 'm5');
  const mm = resumeMessage(onMac, f);
  assert.match(mm, /working tree and your history are intact/);
  assert.doesNotMatch(mm, /Unity/);
});

const file = (over: Partial<ResumeFile> = {}): ResumeFile => ({
  version: 1,
  reason: 'restart',
  update: false,
  at: '2026-09-23T18:00:00Z',
  sessions: [],
  orchestratorBusy: false,
  ...over,
});

test('summary: resumed, failed, update result and code change', () => {
  const s = restartSummary(
    file({ update: true, reason: 'update' }),
    [
      { id: 'a', title: 'Shaders', sandboxId: 'sb1', ok: true },
      { id: 'b', title: 'Docs', ok: false, error: 'already 6 agents running' },
    ],
    { ok: true, at: '2026-09-23T18:01:00Z', headBefore: 'aaaaaaaaaaaa', headAfter: 'bbbbbbbbbbbb' },
    { head: 'bbbbbbbbbbbb' },
  );
  assert.match(s, /^\[app restarted\]/);
  assert.match(s, /Update OK \(aaaaaaaaa → bbbbbbbbb\)/);
  assert.match(s, /Resumed automatically: "Shaders" \(a in sb1\)/);
  assert.match(s, /Could not resume: "Docs" \(b\): already 6 agents running/);
  assert.match(restartSummary(file({ update: true }), [], { ok: false, at: 'x', error: 'npm ci failed' }, {}), /Update FAILED: npm ci failed/);
  assert.match(restartSummary(file({ update: true }), [], undefined, {}), /Update result: unknown/);
  assert.match(restartSummary(file({ head: 'aaaaaaaaaaaa' }), [], undefined, { head: 'cccccccccccc' }), /Code changed aaaaaaaaa → ccccccccc/);
  assert.match(restartSummary(file({ orchestratorBusy: true }), [], undefined, {}, ['NOTE']), /mid-turn yourself.*NOTE/);
});

test('summary: states the version before and after the restart', () => {
  assert.match(restartSummary(file({ appVersion: '0.1.0' }), [], undefined, { version: '0.2.0' }), /^\[app restarted\][^.]*\)\. Version 0\.1\.0 → 0\.2\.0\./);
  assert.match(restartSummary(file({ appVersion: '0.2.0' }), [], undefined, { version: '0.2.0' }), /Version 0\.2\.0 \(unchanged\)\./);
  // A resume file from a server before versioning: only the new version is known.
  assert.match(restartSummary(file(), [], undefined, { version: '0.1.0' }), /Now version 0\.1\.0\./);
  assert.doesNotMatch(restartSummary(file({ appVersion: '0.1.0' }), [], undefined, {}), /[Vv]ersion/);
  assert.equal(versionLine(undefined, undefined), '');
});

test('restart request: empty or garbage means stop now; JSON is validated', () => {
  assert.equal(parseRestartRequest(''), 'now');
  assert.equal(parseRestartRequest('  \n'), 'now');
  assert.equal(parseRestartRequest('not json'), 'now');
  const bom = String.fromCharCode(0xfeff);
  assert.deepEqual(parseRestartRequest(`${bom}{"drain":"auto","drainMinutes":3,"reason":"update","update":true,"hold":true}`), {
    drain: 'auto',
    drainMinutes: 3,
    reason: 'update',
    update: true,
    hold: true,
  });
  assert.deepEqual(parseRestartRequest('{"drain":"yes please","drainMinutes":-1}'), { drain: 'auto', drainMinutes: 10, reason: 'restart', update: false, hold: false });
  assert.equal((parseRestartRequest('{"drainMinutes":9999}') as RestartRequest).drainMinutes, 120);
  assert.equal((parseRestartRequest('{"drain":false}') as RestartRequest).drain, false);
});

test('resume file: written atomically, taken once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-resume-'));
  try {
    assert.equal(takeResumeFile(dir), undefined);
    writeResumeFile(dir, file({ sessions: [{ id: 'a', kind: 'worker', title: 'a', why: 'mid-turn', unanswered: [], lastFrom: 'human' }] }));
    assert.equal(takeResumeFile(dir)?.sessions[0].id, 'a');
    assert.equal(takeResumeFile(dir), undefined, 'a second boot must not resume again');
    fs.writeFileSync(path.join(dir, 'resume.json'), '{ torn');
    assert.equal(takeResumeFile(dir), undefined);
    // PowerShell writes a BOM; results older than the stop are not this update's.
    fs.writeFileSync(path.join(dir, 'update.result.json'), String.fromCharCode(0xfeff) + '{"ok":true,"at":"2026-09-23T18:05:00Z"}');
    assert.equal(readUpdateResult(dir, '2026-09-23T18:00:00Z')?.ok, true);
    assert.equal(readUpdateResult(dir, '2026-09-23T18:10:00Z'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('systemd supervisor: only the VM unit variable together with an INVOCATION_ID systemd set', () => {
  assert.equal(systemdSupervised({}), false);
  assert.equal(systemdSupervised({ FFSB_SUPERVISOR: 'systemd' }), false, 'a shell that copied the variable is not systemd');
  assert.equal(systemdSupervised({ INVOCATION_ID: '0123abcd' }), false, 'another unit (a test runner under systemd) is not the portal');
  assert.equal(systemdSupervised({ FFSB_SUPERVISOR: 'systemd', INVOCATION_ID: '0123abcd' }), true);
});

test('update.wanted: what the VM updater reads, written whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-wanted-'));
  try {
    writeUpdateWanted(dir, { drainMinutes: 7, reason: 'update (request_app_update)' }, new Date('2026-10-05T12:00:00Z'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'update.wanted'), 'utf8')), { drainMinutes: 7, reason: 'update (request_app_update)', at: '2026-10-05T12:00:00.000Z' });
    assert.deepEqual(fs.readdirSync(dir), ['update.wanted'], 'no temp file left beside it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function harness(sessions: SessionSnapshot[], dataDir = os.tmpdir()) {
  const told: [string, string][] = [];
  const stops: { req: RestartRequest; drained: string[] }[] = [];
  const d = new Drainer({
    dataDir,
    snapshot: () => sessions,
    tell: (id, text) => void told.push([id, text]),
    stop: (req, drained) => void stops.push({ req, drained: [...drained] }),
    changed: () => undefined,
    log: () => undefined,
  });
  return { d, told, stops };
}

const REQ: RestartRequest = { drain: 'auto', drainMinutes: 10, reason: 'update', update: true, hold: false };

test('drain: nobody busy restarts after a short grace, without messaging anyone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const h = harness([snap({ id: 'a', status: 'idle' }), snap({ id: 'o', kind: 'orchestrator', status: 'running' })]);
  assert.match(h.d.request(REQ), /restarting now/);
  assert.equal(h.stops.length, 0, 'the caller gets its reply first');
  t.mock.timers.tick(5000);
  assert.equal(h.stops.length, 1);
  assert.deepEqual(h.told, []);
});

test('drain: busy workers are asked to wrap up; the restart follows once they are idle', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const sessions = [snap({ id: 'a', status: 'running' }), snap({ id: 'b', status: 'idle' }), snap({ id: 's', kind: 'standing', status: 'running' })];
  const h = harness(sessions);
  assert.match(h.d.request(REQ), /draining: asked 1 busy agent/);
  assert.deepEqual(h.told.map(([id]) => id), ['a']);
  assert.ok(h.told[0][1].startsWith(DRAIN_TAG));
  assert.deepEqual(h.d.status?.waitingFor, ['a']);
  assert.match(h.d.request(REQ), /already pending/, 'a second request does not start a second drain');
  t.mock.timers.tick(30_000);
  assert.equal(h.stops.length, 0);
  sessions[0].status = 'idle';
  t.mock.timers.tick(3000);
  assert.deepEqual(h.stops.map((s) => s.drained), [['a']]);
});

test('drain: the deadline wins over an agent that will not stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const h = harness([snap({ id: 'a', status: 'running' })]);
  h.d.request({ ...REQ, drainMinutes: 2 });
  t.mock.timers.tick(119_000);
  assert.equal(h.stops.length, 0);
  t.mock.timers.tick(3000);
  assert.equal(h.stops.length, 1);
});

test('drain with hold: signals drain.done, then waits for the stop; gives up if it never comes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-drain-'));
  try {
    const sessions = [snap({ id: 'a', status: 'running' })];
    const h = harness(sessions, dir);
    h.d.request({ ...REQ, hold: true });
    sessions[0].status = 'idle';
    t.mock.timers.tick(3000);
    assert.ok(fs.existsSync(path.join(dir, 'drain.done')));
    assert.equal(h.stops.length, 0, 'held: restart.ps1 stops the supervisor first');
    t.mock.timers.tick(5 * 60_000 + 3000);
    assert.equal(h.stops.length, 0);
    assert.equal(h.d.status, undefined, 'gave up and carried on');
    assert.ok(!fs.existsSync(path.join(dir, 'drain.done')));
    assert.match(h.told.at(-1)![1], /restart cancelled/);
    // And a later stop request works as usual.
    h.d.stopNow({ ...REQ, reason: 'restart' });
    assert.equal(h.stops.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('drain: -NoDrain restarts at once even with busy agents (they are resumed afterwards)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const h = harness([snap({ id: 'a', status: 'running' })]);
  assert.match(h.d.request({ ...REQ, drain: false }), /1 busy agent\(s\) are resumed/);
  assert.deepEqual(h.told, []);
  t.mock.timers.tick(5000);
  assert.equal(h.stops.length, 1);
  assert.match(drainMessage(REQ, new Date()), /commit your work/);
});

test('w467: the update log is named where it is: the journal in the portal VM, data/supervisor.log on Windows', () => {
  assert.equal(updateLogHint({ FFSB_SUPERVISOR: 'systemd' }), 'journalctl -u fff-update in the VM (or fffctl logs)');
  assert.equal(updateLogHint({}), 'data/supervisor.log');
});

// ---------------------------------------------------------------- relocate at the cut-over (w499)

test('restart request: relocate is read as a base URL (trailing slash dropped), anything else is kept to be refused', () => {
  const r = (j: object) => parseRestartRequest(JSON.stringify(j));
  assert.deepEqual(r({ drain: true, hold: true, relocate: ' https://fff.example.ts.net/ ' }), { drain: true, drainMinutes: 10, reason: 'restart', update: false, hold: true, relocate: 'https://fff.example.ts.net' });
  assert.equal((r({ hold: true }) as RestartRequest).relocate, undefined, 'none: no key at all');
  assert.equal((r({ relocate: 42 }) as RestartRequest).relocate, '42');
  assert.equal((r({ relocate: '' }) as RestartRequest).relocate, '');
});

function relocating(dir: string, sessions: SessionSnapshot[], relocate?: (url: string) => Promise<RelocateOutcome[]>) {
  const lines: string[] = [];
  const order: string[] = [];
  const stops: RestartRequest[] = [];
  const d = new Drainer({
    dataDir: dir,
    snapshot: () => sessions,
    tell: () => undefined,
    stop: (req) => void (stops.push(req), order.push('stop')),
    changed: () => undefined,
    log: (l) => void lines.push(l),
    ...(relocate ? { relocate: async (url: string) => (order.push(`relocate ${url}`), relocate(url)) } : {}),
  });
  return { d, lines, order, stops };
}
const settle = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

test('drain with hold and relocate: the daemons go first, their outcome is written, then drain.done; once only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-drain-relocate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, RELOCATE_RESULT_FILE), '{"stale":true}');
  let calls = 0;
  const h = relocating(dir, [snap({ id: 'o', kind: 'orchestrator', status: 'idle' })], async () => {
    calls++;
    // drain.done must not be there yet while the daemons are being moved.
    assert.equal(fs.existsSync(path.join(dir, 'drain.done')), false);
    return [
      { machine: 'beast', ok: true, note: 'beast took it' },
      { machine: 'm3', ok: false, note: "m3's daemon speaks protocol 7 and cannot relocate" },
    ];
  });
  // A hold keeps its 3 s check running for 5 minutes: stopped here, so the test file ends.
  t.after(() => h.d.stopNow(REQ));
  assert.match(h.d.request({ ...REQ, drain: true, hold: true, relocate: 'https://fff.example.ts.net' }), /restarting now/);
  await settle(() => fs.existsSync(path.join(dir, 'drain.done')));
  assert.ok(fs.existsSync(path.join(dir, 'drain.done')));
  const result = JSON.parse(fs.readFileSync(path.join(dir, RELOCATE_RESULT_FILE), 'utf8'));
  assert.equal(result.url, 'https://fff.example.ts.net');
  assert.equal(result.ok, false, 'one machine did not take it');
  assert.deepEqual(result.machines.map((m: RelocateOutcome) => [m.machine, m.ok]), [['beast', true], ['m3', false]]);
  assert.equal(calls, 1);
  assert.deepEqual(h.stops, [], 'held: the script stops it');
  assert.ok(h.lines.some((l) => /relocate to https:\/\/fff\.example\.ts\.net: 1 of 2 connected daemon\(s\) took it; not: m3 \(m3's daemon speaks protocol 7/.test(l)), h.lines.join(String.fromCharCode(10)));
});

test('drain with relocate and no hold: relocated, then stopped', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-drain-relocate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = [snap({ id: 'a', status: 'running' })];
  const h = relocating(dir, sessions, async () => [{ machine: 'm5', ok: true, note: 'ok' }]);
  // A hold keeps its 3 s check running for 5 minutes: stopped here, so the test file ends.
  t.after(() => h.d.stopNow(REQ));
  t.mock.timers.enable({ apis: ['setInterval'] });
  assert.match(h.d.request({ ...REQ, drain: true, relocate: 'http://127.0.0.1:8790' }), /draining/);
  sessions[0].status = 'idle';
  t.mock.timers.tick(3000);
  // The check sees the drain done: the relocate starts; further checks wait for it.
  t.mock.timers.tick(3000);
  t.mock.timers.tick(3000);
  t.mock.timers.reset();
  await settle(() => h.stops.length > 0);
  assert.deepEqual(h.order, ['relocate http://127.0.0.1:8790', 'stop']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, RELOCATE_RESULT_FILE), 'utf8')).ok, true);
});

test('drain with relocate: a URL that is not a portal base URL, or a server that cannot relocate, refuses the whole request', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-drain-relocate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = relocating(dir, [], async () => assert.fail('not sent'));
  // A hold keeps its 3 s check running for 5 minutes: stopped here, so the test file ends.
  t.after(() => h.d.stopNow(REQ));
  for (const bad of ['', 'fff.example.ts.net', 'https://fff.example.ts.net/x', 'ws://x']) {
    assert.match(h.d.request({ ...REQ, hold: true, relocate: bad }), /^refused: relocate: /, bad);
    const r = JSON.parse(fs.readFileSync(path.join(dir, RELOCATE_RESULT_FILE), 'utf8'));
    assert.equal(r.ok, false);
    assert.match(r.error, /not a portal base URL|not a URL/);
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.existsSync(path.join(dir, 'drain.done')), false, 'no drain, no hold');
  assert.deepEqual(h.stops, []);
  const none = relocating(dir, []);
  assert.match(none.d.request({ ...REQ, hold: true, relocate: 'https://fff.example.ts.net' }), /refused: relocate: this server cannot relocate machines/);
  // The refusal leaves the drainer free for the next request.
  assert.match(h.d.request({ ...REQ, hold: true }), /restarting now/);
});

test('drain with relocate: a relocate that throws is written as the error, and the hold still comes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-drain-relocate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = relocating(dir, [], async () => {
    throw new Error('the machine manager is gone');
  });
  // A hold keeps its 3 s check running for 5 minutes: stopped here, so the test file ends.
  t.after(() => h.d.stopNow(REQ));
  h.d.request({ ...REQ, hold: true, relocate: 'https://fff.example.ts.net' });
  await settle(() => fs.existsSync(path.join(dir, 'drain.done')));
  const r = JSON.parse(fs.readFileSync(path.join(dir, RELOCATE_RESULT_FILE), 'utf8'));
  assert.deepEqual([r.ok, r.error, r.machines], [false, 'the machine manager is gone', []]);
});
