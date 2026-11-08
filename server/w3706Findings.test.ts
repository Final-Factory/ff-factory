// w3706: every request keeps a "Findings / outcome" record: each worker report whole, kept across hand-offs, and a final
// outcome written by every close. lothsahn, 2026-11-08: "every time a worker finishes the ledger gets updated for a
// workitem about its findings or outcomes before the workitem is closed. That way you can look things up quickly without
// the full transcript". Answering "what were the vSync findings?" for w3639 had meant reading two workers' transcripts:
// the ledger kept a "Latest:" line cut at 200 characters, and the first worker's (8d83fbf2) findings were lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { LedgerSweep } from './ledgerSweep.ts';
import { readWork } from './workRead.ts';
import { FINDING_CHARS, FINDING_HEAD, FINDINGS_CHARS, findingTargets, recordFinding, settleOutcome } from './findings.ts';
import type { PrRecord } from './ledgerRules.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { useFakeVault } from './testVault.ts';

useFakeVault();
setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const PEOPLE: UserInfo[] = [{ ...LOTH, role: 'owner' }];
const REPO = 'Final-Factory/FinalFactory';
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return { id, title: `Fix ${id}`, brief: 'Make it work.', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: true, status: 'active', createdAt: hoursAgo(72), updatedAt: hoursAgo(70), sessionIds: [], overlaps: [], asks: 0, log: [], ...over } as WorkItem;
}

/** The first worker's findings on w3639 (vSync), longer than any Latest line or log line keeps. */
const FIRST = [
  'TL;DR: the rate drops come from the frame pacer, not vSync: QualitySettings.vSyncCount flips to 0 when the window loses focus.',
  '',
  'Measured on BEAST (60 Hz panel, 2026-11-07): 58 of 60 frames at 16.7 ms, then 11 frames at 33.3 ms after each alt-tab (measured, 5 runs).',
  'Sourced: Unity 6000.3 docs say runInBackground keeps vSyncCount; our FocusWatcher.cs:88 sets it to 0 (read).',
  'Guess: the 2 slow frames at start are shader warm-up.',
  'Open: the fix in FocusWatcher.cs; a 60 fps clip to confirm.',
  '',
  'w3639: still open: fixing FocusWatcher.cs',
].join('\n');

test('w3706: a report is kept whole on the requests it names (all of them when it names none), once, under a few KB', () => {
  const a = item('w1');
  const b = item('w2');
  assert.deepEqual(findingTargets([a, b], 'For w2: the fix is in.').map((w) => w.id), ['w2']);
  assert.deepEqual(findingTargets([a, b], 'The fix is in.').map((w) => w.id), ['w1', 'w2']);
  assert.equal(recordFinding(a, 's1', `  ${FIRST}  `), true);
  assert.equal(a.findings![0]!.text, FIRST, 'whole, not a first line or 200 characters');
  assert.equal(recordFinding(a, 's1', FIRST), false, 'the same report again is not kept twice');
  assert.equal(recordFinding(a, 's1', '   '), false);
  // A long report keeps its head (the TL;DR), and says how long it was.
  recordFinding(a, 's2', `TL;DR: long.\n${'x'.repeat(FINDING_CHARS * 2)}`);
  assert.equal(a.findings!.at(-1)!.text.length, FINDING_CHARS);
  assert.equal(a.findings!.at(-1)!.chars, FINDING_CHARS * 2 + 13);
  // Many turns: the record stays under its budget, the newest whole, older ones shrunk to their heads; each worker's first
  // report (what it found first) outlives its later ones.
  for (let i = 0; i < 12; i++) recordFinding(a, 's2', `Turn ${i}: ${'y'.repeat(2_000)}`);
  const kept = a.findings!;
  assert.ok(kept.reduce((n, f) => n + f.text.length, 0) <= FINDINGS_CHARS);
  assert.equal(kept.at(-1)!.text.length, 2_009, 'the newest is whole');
  assert.ok(kept.slice(0, -1).every((f) => f.text.length <= FINDING_HEAD));
  assert.equal(kept[0]!.by, 's1', "the first worker's findings are still there");
  assert.match(kept[0]!.text, /^TL;DR: the rate drops come from the frame pacer/);
  assert.equal(kept.filter((f) => f.by === 's2')[0]!.text.startsWith('TL;DR: long.'), true, "the second worker's first report too");
});

test('w3706: a close writes the outcome (the note and the last worker report); a reopen keeps it as history', () => {
  const w = item('w1');
  recordFinding(w, 's1', FIRST);
  settleOutcome(w);
  assert.equal(w.finalOutcome, undefined, 'open: no outcome yet');
  w.status = 'done';
  w.outcome = 'closed automatically by the ledger cleanup: merged as #12';
  settleOutcome(w);
  assert.equal(w.finalOutcome!.status, 'done');
  assert.ok(w.finalOutcome!.text.startsWith('closed automatically by the ledger cleanup: merged as #12\n\nThe last worker report (worker s1, '));
  assert.ok(w.finalOutcome!.text.includes('Measured on BEAST (60 Hz panel'), 'generated from the worker report the note lacks');
  const at = w.finalOutcome!.at;
  settleOutcome(w);
  assert.equal(w.finalOutcome!.at, at, 'a later save of the closed request leaves it be');
  // A note that holds the report already is the outcome alone.
  const d = item('w2', { status: 'done', outcome: `Done.\n${FIRST}` });
  recordFinding(d, 's1', FIRST);
  settleOutcome(d);
  assert.equal(d.finalOutcome!.text, `Done.\n${FIRST}`);
  // Reopened: the outcome moves into the reports, so a second close writes a new one and the first stays readable.
  w.status = 'active';
  settleOutcome(w);
  assert.equal(w.finalOutcome, undefined);
  assert.match(w.findings!.at(-1)!.text, /^Closed as done, then reopened\. Its outcome then: closed automatically/);
  assert.equal(w.findings!.at(-1)!.by, 'ledger');
  // An item saved without a status (a torn work.json's stand-in) is left alone.
  const bare = { id: 'w9' } as WorkItem;
  settleOutcome(bare);
  assert.equal(bare.finalOutcome, undefined);
});

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w3706-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    ledger: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  const o = agents.orchestrators;
  const world = { prs: [] as PrRecord[] };
  const sweep = new LedgerSweep({
    cfg,
    store,
    orchestrators: o,
    repos: async () => [REPO],
    prs: async () => world.prs,
    viewPr: async () => undefined,
    resume: () => {},
    limitsClear: () => true,
    appRepo: async () => 'Final-Factory/ff-factory',
    portalSha: () => undefined,
    daemons: () => undefined,
    contains: async () => false,
    now: () => Date.now(),
  } as never);
  t.after(async () => {
    sweep.close();
    o.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const request = (id: string, over: Partial<WorkItem> = {}) => {
    const w = item(id, over);
    store.putWork(w);
    return w;
  };
  const worker = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => {
    const s = { id, kind: 'worker', title: `Worker ${id}`, status: 'idle', permissionMode: 'bypassPermissions', createdAt: hoursAgo(72), lastActivityAt: hoursAgo(60), turns: 3, costUsd: 1, pendingPermissions: [], requestedBy: LOTH, ...over } as SessionInfo;
    store.putSession(s);
    return s;
  };
  /** list_work as an orchestrator calls it (the dispatcher's belt; a person's sees the same entry). */
  const listWork = async (id: string, who: SessionInfo = sessions.get(agents.dispatcherId)!.info) => {
    const tool = agents.orchestratorBelt(who).find((x) => x.name === 'list_work')!;
    return (await tool.handler({ id })).content.map((c: { text: string }) => c.text).join('\n');
  };
  const updateWork = async (args: Record<string, unknown>) => {
    const tool = agents.orchestratorBelt(o.personalFor(LOTH).info).find((x) => x.name === 'update_work')!;
    return (await tool.handler(args)).content.map((c: { text: string }) => c.text).join('\n');
  };
  return { store, o, sweep, world, request, worker, listWork, updateWork };
}

test('w3706: a request moved between workers keeps both workers\' findings; its DONE closes it with the outcome, and list_work id and read_work show all of it in full', async (t) => {
  const { store, o, request, worker, listWork } = setup(t);
  request('w3639', { title: 'vSync still drops to a slower rate', sessionIds: ['8d83fbf2'] });
  const first = worker('8d83fbf2');
  o.workerTurnEnded(first, FIRST);
  // The request moves to another worker (a hand-off: the first one is off it).
  const w = store.work.get('w3639')!;
  w.sessionIds = ['c94b1f62'];
  store.putWork(w);
  const second = worker('c94b1f62');
  const done = [
    'TL;DR: fixed. FocusWatcher.cs no longer zeroes vSyncCount on focus loss; PR #3443 merged at 1a2b3c4.',
    'Measured after the fix on BEAST: 60 of 60 frames at 16.7 ms across 5 alt-tabs (measured).',
    'Nothing is left open.',
    '',
    'DONE: w3639',
    'Learned: nothing new',
  ].join('\n');
  o.workerTurnEnded(second, done);
  const closed = store.work.get('w3639')!;
  assert.equal(closed.status, 'done', closed.log.slice(-3).join(' | '));
  assert.deepEqual(closed.findings!.map((f) => f.by), ['8d83fbf2', 'c94b1f62']);
  assert.equal(closed.finalOutcome!.status, 'done');
  assert.ok(closed.finalOutcome!.text.includes('60 of 60 frames at 16.7 ms'), 'the DONE note is its first line; the outcome holds the whole report');
  const listed = await listWork('w3639');
  assert.match(listed, /\nFindings \/ outcome \(w3706: kept across its workers; the outcome, then 2 worker reports, newest first\):\n {2}Outcome \(done, /);
  // Every line of both reports is there, past the 200-character Latest line and the 300-character log line.
  for (const line of [...FIRST.split('\n'), ...done.split('\n')].filter(Boolean)) assert.ok(listed.includes(line), `list_work id shows "${line}"`);
  assert.match(listed, / worker c94b1f62:\n {4}\(quoted in the outcome above\)/);
  assert.ok(listed.indexOf('worker c94b1f62') < listed.indexOf('worker 8d83fbf2'), 'newest first');
  // A worker reading the request (read_work) gets the same record.
  const read = readWork([...store.work.values()], 'c94b1f62', { id: 'w3639' }, new Map());
  assert.match(read, /\nFindings \/ outcome \(w3706/);
  for (const line of FIRST.split('\n').filter(Boolean)) assert.ok(read.includes(line), `read_work shows "${line}"`);
});

test('w3706: a close by a person or by the ledger cleanup (a merged PR) gets an outcome generated from the last worker report', async (t) => {
  const { store, o, sweep, world, request, worker, listWork, updateWork } = setup(t);
  request('w1', { sessionIds: ['s1'] });
  request('w2', { sessionIds: ['s2'] });
  o.workerTurnEnded(worker('s1'), FIRST.replace('w3639', 'w1'));
  // The cleanup closes w2 when its PR merges; its worker's last report is the outcome's substance.
  const s2 = worker('s2', { lastResult: 'The belts are fixed; PR #11 is up.\nDONE: w2' });
  o.workerTurnEnded(s2, 'TL;DR: belts fixed by sorting the queue by entity index (BeltQueue.cs:41); 400 belts tick in 0.8 ms (measured). PR #11 is up.\nw2: still open: blocked on CI on #11');
  world.prs = [{ repo: REPO, number: 11, url: `https://github.com/${REPO}/pull/11`, title: 'PR 11', body: 'Request: w2', head: 'sandbox/x11', base: 'develop', state: 'merged', createdAt: hoursAgo(50), mergedAt: hoursAgo(40), sha: '11'.repeat(20) }];
  await sweep.checkPrs();
  const w2 = store.work.get('w2')!;
  assert.equal(w2.status, 'done', w2.log.slice(-3).join(' | '));
  assert.match(w2.finalOutcome!.text, /^closed automatically: merged as #11/);
  assert.match(w2.finalOutcome!.text, /The last worker report \(worker s2, [^)]+\):\nTL;DR: belts fixed by sorting the queue by entity index \(BeltQueue\.cs:41\); 400 belts tick in 0\.8 ms \(measured\)/);
  assert.match(await listWork('w2'), /Outcome \(done, [^)]+\):\n {4}closed automatically: merged as #11/);
  // A person closes w1 with a short note; the outcome keeps the note and the worker's findings.
  const said = await updateWork({ id: 'w1', close: 'cancelled', note: 'Not needed any more: the panel is gone.' });
  const w1 = store.work.get('w1')!;
  assert.equal(w1.status, 'cancelled', said);
  assert.match(w1.finalOutcome!.text, /Not needed any more: the panel is gone\./);
  assert.ok(w1.finalOutcome!.text.includes('Measured on BEAST (60 Hz panel'));
});
