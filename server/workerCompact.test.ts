import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, setQueryForTesting, type AutoCompaction, type SessionHandle, type TurnEndMeta } from './sessions.ts';
import { AutoCompactor, WORKER_COMPACT_DEFAULTS, compactBlocker, inPilot, workerCompactSettings, workerCompactionDue } from './autoCompact.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { SessionInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * w1469 (lothsahn: "Build 1, 2 and 4: compact at ~200k, compact before long waits, trim the base"): workers compact by
 * themselves, between turns, past worker.compactAtTokens; first a pilot share of worker sessions. Against the scripted fake SDK ("#ctx <tokens>"
 * sets the context, "/compact" compacts to 18,000 tokens).
 */

setQueryForTesting(fakeQuery({ stepMs: 1, slowStepMs: 25 }) as never);

const info = (p: Partial<SessionInfo>) => ({ contextTokens: 0, turns: 5, ...p }) as Pick<SessionInfo, 'contextTokens' | 'lastTurnCostUsd' | 'lastCompaction' | 'turns'>;

test('workerCompactSettings: defaults 200,000 and a 34% pilot; config sets them; 0 is off', () => {
  assert.deepEqual(workerCompactSettings({}), { ...WORKER_COMPACT_DEFAULTS });
  assert.deepEqual(workerCompactSettings({ worker: { compactAtTokens: 0, compactPilotPercent: 250 } as Config['worker'] }), { atTokens: 0, pilotPercent: 100 });
});

test('workerCompactionDue: past 200,000; never on a costly turn alone', () => {
  const s = workerCompactSettings({});
  assert.equal(workerCompactionDue(info({ contextTokens: 150_000, lastTurnCostUsd: 30 }), s), undefined, 'a long turn is a worker\'s nature');
  assert.deepEqual(workerCompactionDue(info({ contextTokens: 210_000 }), s), { trigger: 'tokens', reason: 'the context passed 200,000 tokens' });
  assert.equal(workerCompactionDue(info({ contextTokens: 210_000 }), { ...s, atTokens: 0 }), undefined);
});

test('inPilot: a stable share of session ids', () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `s-${i.toString(36)}-${(i * 7919).toString(16)}`);
  const share = ids.filter((id) => inPilot(id, 34)).length / ids.length;
  assert.ok(share > 0.3 && share < 0.38, `share ${share}`);
  for (const id of ids.slice(0, 50)) assert.equal(inPilot(id, 34), inPilot(id, 34));
  assert.ok(ids.every((id) => inPilot(id, 100)));
  assert.ok(!ids.some((id) => inPilot(id, 0)));
});

test('compactBlocker: a worker whose daemon cannot compact is left alone', () => {
  const s = { info: { kind: 'worker', sdkSessionId: 'x', status: 'idle', pendingPermissions: [] }, live: true } as unknown as SessionHandle;
  assert.equal(compactBlocker(s, false), 'its daemon cannot compact');
});

function setup(t: { after: (fn: () => void | Promise<void>) => void }, worker: Partial<Config['worker']>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-workercompact-'));
  const store = new Store(dir);
  const cfg = { limits: { maxSessions: 6 }, orchestrator: { model: 'opus', effort: 'low' }, worker: { permissionMode: 'bypassPermissions', effort: 'high', ...worker } } as unknown as Config;
  const sessions = new SessionManager(cfg, store);
  const auto = new AutoCompactor(sessions, cfg, { settleMs: 20 });
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
  return { sessions, compactions, ends, w, say };
}

async function until(pred: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('past 200,000 a worker in the pilot compacts; one outside the pilot never does', async (t) => {
  const inside = setup(t, { compactPilotPercent: 100 });
  inside.say('big #ctx 210000');
  await until(() => !!inside.w.info.lastCompaction && inside.w.info.status === 'idle', 'the compaction');
  assert.equal(inside.compactions[0].auto?.trigger, 'tokens');
  const outside = setup(t, { compactPilotPercent: 0 });
  outside.say('big #ctx 210000');
  await until(() => outside.w.info.status === 'idle' && outside.w.info.turns === 1, 'the turn');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(outside.compactions.length, 0);
});
