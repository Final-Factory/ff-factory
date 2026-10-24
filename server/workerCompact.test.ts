import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, setQueryForTesting, type AutoCompaction, type SessionHandle, type TurnEndMeta } from './sessions.ts';
import { AutoCompactor, EARLY_COMPACT_MARK, WORKER_COMPACT_DEFAULTS, WORKER_FOCUS, compactBlocker, earlyCompactSettings, inEarlyCompactPilot, inPilot, withEarlyCompactMark, workerAutoCompactWindow, workerCompactSettings, workerCompactionDue } from './autoCompact.ts';
import { workerSettings } from './agents.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { SessionInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * w1469 (lothsahn: "Build 1, 2 and 4: compact at ~200k, compact before long waits, trim the base"): workers compact by
 * themselves, between turns, past worker.compactAtTokens, and right after a turn that ends in a long wait past
 * worker.compactBeforeWaitTokens; first a pilot share of worker sessions. Against the scripted fake SDK ("#ctx <tokens>"
 * sets the context, "/compact" compacts to 18,000 tokens).
 */

setQueryForTesting(fakeQuery({ stepMs: 1, slowStepMs: 25 }) as never);

const info = (p: Partial<SessionInfo>) => ({ contextTokens: 0, turns: 5, ...p }) as Pick<SessionInfo, 'contextTokens' | 'lastTurnCostUsd' | 'lastCompaction' | 'turns'>;

test('workerCompactSettings: defaults 200,000, 100,000 before a wait, a 34% pilot; config sets them; 0 is off', () => {
  assert.deepEqual(workerCompactSettings({}), { ...WORKER_COMPACT_DEFAULTS });
  assert.deepEqual(workerCompactSettings({ worker: { compactAtTokens: 0, compactBeforeWaitTokens: 150_000, compactPilotPercent: 250 } as Config['worker'] }), { atTokens: 0, beforeWaitTokens: 150_000, pilotPercent: 100 });
});

test('workerCompactionDue: before a long wait from 100,000; else past 200,000; never on a costly turn alone', () => {
  const s = workerCompactSettings({});
  assert.equal(workerCompactionDue(info({ contextTokens: 150_000, lastTurnCostUsd: 30 }), s), undefined, 'a long turn is a worker\'s nature');
  assert.equal(workerCompactionDue(info({ contextTokens: 99_000 }), s, 'it waits on Ben'), undefined, 'too small to be worth it');
  assert.deepEqual(workerCompactionDue(info({ contextTokens: 150_000 }), s, 'it waits on Ben: approve'), { trigger: 'wait', reason: 'it waits (it waits on Ben: approve) with the context at 150,000 tokens' });
  assert.deepEqual(workerCompactionDue(info({ contextTokens: 210_000 }), s), { trigger: 'tokens', reason: 'the context passed 200,000 tokens' });
  assert.equal(workerCompactionDue(info({ contextTokens: 210_000 }), { ...s, atTokens: 0 }), undefined);
  assert.equal(workerCompactionDue(info({ contextTokens: 150_000 }), { ...s, beforeWaitTokens: 0 }, 'a person'), undefined);
});

test('inPilot: a stable share of session ids', () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `s-${i.toString(36)}-${(i * 7919).toString(16)}`);
  const share = ids.filter((id) => inPilot(id, 34)).length / ids.length;
  assert.ok(share > 0.3 && share < 0.38, `share ${share}`);
  for (const id of ids.slice(0, 50)) assert.equal(inPilot(id, 34), inPilot(id, 34));
  assert.ok(ids.every((id) => inPilot(id, 100)));
  assert.ok(!ids.some((id) => inPilot(id, 0)));
});

test('w2002: the earlier-compaction pilot: half the workers by default, 120,000 between turns and 150,000 within a turn, never under 80,000', () => {
  assert.deepEqual(earlyCompactSettings({}), { pilotPercent: 50, atTokens: 120_000, midTurnTokens: 150_000 });
  assert.deepEqual(earlyCompactSettings({ worker: { earlyCompactPilotPercent: 300, earlyCompactAtTokens: 40_000, earlyCompactMidTurnTokens: 60_000 } as Config['worker'] }), { pilotPercent: 100, atTokens: 80_000, midTurnTokens: 80_000 });
  const ids = Array.from({ length: 2000 }, (_, i) => `s-${i.toString(36)}-${(i * 7919).toString(16)}`);
  const early = ids.filter((id) => inEarlyCompactPilot(id, {}));
  assert.ok(early.length / ids.length > 0.45 && early.length / ids.length < 0.55, `share ${early.length / ids.length}`);
  // drawn apart from w1469's pilot: the arm is not the same sessions as inPilot's
  const both = early.filter((id) => inPilot(id, 50)).length / early.length;
  assert.ok(both > 0.4 && both < 0.6, `overlap ${both}`);
  const [inArm, outArm] = [early[0], ids.find((id) => !inEarlyCompactPilot(id, {}))!];
  assert.equal(workerCompactSettings({}, inArm).atTokens, 120_000, 'the arm compacts between turns from 120,000');
  assert.equal(workerCompactSettings({}, outArm).atTokens, 200_000, 'the control arm as before');
  assert.equal(workerCompactSettings({ worker: { compactAtTokens: 0 } as Config['worker'] }, inArm).atTokens, 0, 'compaction off stays off');
  assert.equal(workerAutoCompactWindow(inArm, {}), 183_000, "Claude Code's window: 150,000 + its 20,000 reserve and 13,000 buffer");
  assert.equal(workerAutoCompactWindow(outArm, {}), undefined);
  assert.deepEqual(workerSettings(inArm, {}), { enabledPlugins: { 'csharp-lsp@claude-plugins-official': false }, autoCompactWindow: 183_000 });
  assert.deepEqual(workerSettings(outArm, {}), { enabledPlugins: { 'csharp-lsp@claude-plugins-official': false } });
  assert.ok(withEarlyCompactMark('brief', inArm, {}).startsWith(`brief\n\n${EARLY_COMPACT_MARK}\n`), 'the arm is marked in the prompt');
  assert.equal(withEarlyCompactMark('brief', outArm, {}), 'brief');
  assert.equal(workerAutoCompactWindow(inArm, { worker: { earlyCompactPilotPercent: 0 } as Config['worker'] }), undefined, '0 ends the pilot');
});

test('w2002: a worker in the early arm compacts between turns past 120,000; one in the control arm waits for 200,000', async (t) => {
  const early = Array.from({ length: 200 }, (_, i) => `e-${i}`).find((id) => inEarlyCompactPilot(id, {}))!;
  const control = Array.from({ length: 200 }, (_, i) => `e-${i}`).find((id) => !inEarlyCompactPilot(id, {}))!;
  for (const id of [early, control]) {
    const due = workerCompactionDue(info({ contextTokens: 130_000 }), workerCompactSettings({}, id));
    if (id === early) assert.deepEqual(due, { trigger: 'tokens', reason: 'the context passed 120,000 tokens' });
    else assert.equal(due, undefined);
  }
  t.diagnostic(`early ${early}, control ${control}`);
});

test('compactBlocker: a worker whose daemon cannot compact is left alone', () => {
  const s = { info: { kind: 'worker', sdkSessionId: 'x', status: 'idle', pendingPermissions: [] }, live: true } as unknown as SessionHandle;
  assert.equal(compactBlocker(s, false), 'its daemon cannot compact');
});

function setup(t: { after: (fn: () => void | Promise<void>) => void }, worker: Partial<Config['worker']>, waits: { why?: string; move?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-workercompact-'));
  const store = new Store(dir);
  const cfg = { limits: { maxSessions: 6 }, orchestrator: { model: 'opus', effort: 'low' }, worker: { permissionMode: 'bypassPermissions', effort: 'high', earlyCompactPilotPercent: 0, ...worker } } as unknown as Config;
  const sessions = new SessionManager(cfg, store);
  const auto = new AutoCompactor(sessions, cfg, { settleMs: 20, waitsLong: () => waits.why, moving: () => waits.move });
  t.after(async () => {
    auto.stop();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const compactions: { focus: string; auto?: AutoCompaction }[] = [];
  const real = sessions.compact.bind(sessions);
  sessions.compact = (id, focus = '', by, a) => {
    compactions.push({ focus, ...(a ? { auto: a } : {}) });
    return real(id, focus, by, a);
  };
  const ends: { text: string; meta?: TurnEndMeta }[] = [];
  sessions.events.on('turnEnd', (_h: SessionHandle, text: string, meta?: TurnEndMeta) => ends.push({ text, meta }));
  const w = sessions.create({ kind: 'worker', title: 'w1469: worker', permissionMode: 'bypassPermissions', options: () => ({ model: 'opus' }) });
  const say = (text: string) => sessions.send(w.info.id, text, 'orchestrator');
  return { sessions, auto, compactions, ends, w, say };
}

async function until(pred: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('a worker in the pilot compacts after a turn that ends in a long wait, with the worker focus; its end is marked a compaction', async (t) => {
  const waits: { why?: string } = {};
  const { compactions, ends, w, say } = setup(t, { compactPilotPercent: 100 }, waits);
  say('work #ctx 150000');
  await until(() => w.info.status === 'idle' && w.info.turns === 1, 'the first turn');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(compactions.length, 0, 'it goes on: 150,000 is under 200,000');
  waits.why = 'it waits on Ben: approve the release';
  say('then wait #ctx 160000');
  await until(() => !!w.info.lastCompaction && w.info.status === 'idle', 'the compaction before the wait');
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].focus, WORKER_FOCUS);
  assert.equal(compactions[0].auto?.trigger, 'wait');
  assert.equal(w.info.lastCompaction?.trigger, 'wait');
  assert.equal(w.info.contextTokens, 18_000);
  assert.equal(w.info.lastResult, 'Echo: then wait #ctx 160000', 'the last report stays');
  assert.deepEqual(ends.at(-1)?.meta, { compaction: 'wait' }, 'agents.ts reads no report from it');
});

test('past 200,000 a worker in the pilot compacts; one outside the pilot never does', async (t) => {
  const inside = setup(t, { compactPilotPercent: 100 }, {});
  inside.say('big #ctx 210000');
  await until(() => !!inside.w.info.lastCompaction && inside.w.info.status === 'idle', 'the compaction');
  assert.equal(inside.compactions[0].auto?.trigger, 'tokens');
  const outside = setup(t, { compactPilotPercent: 0 }, { why: 'a person' });
  outside.say('big #ctx 210000');
  await until(() => outside.w.info.status === 'idle' && outside.w.info.turns === 1, 'the turn');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(outside.compactions.length, 0);
});

test('w1745: a worker whose process must restart on another account first is not compacted until it has (7d4cb2df, 2026-10-22)', async (t) => {
  // Its token ran out: the /compact sent then ran on the used-up token, failed at once, and kept the turn open ahead of the
  // resume that moves it. It compacts after the restart, at a later turn's end.
  const waits: { why?: string; move?: string } = { move: 'its process runs on vault token vault-ben-1 …AAAA (weekly 100%: used up)' };
  const { auto, compactions, w, say } = setup(t, { compactPilotPercent: 100 }, waits);
  say('big #ctx 210000');
  await until(() => w.info.status === 'idle' && w.info.turns === 1, 'the turn');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(compactions.length, 0, 'not on the used-up token');
  assert.match(auto.check(w.info.id), /^not now: its process restarts first \(its process runs on vault token vault-ben-1 …AAAA/);
  waits.move = undefined;
  say('moved #ctx 215000');
  await until(() => !!w.info.lastCompaction && w.info.status === 'idle', 'the compaction after the move');
  assert.equal(compactions.length, 1);
});
