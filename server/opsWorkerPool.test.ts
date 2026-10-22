import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OPS_ID, OpsWorker } from './opsWorker.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { Store } from './store.ts';
import { PoolHeldError, Vault, fingerprintOf, newKeyText, type VaultContext } from './vault.ts';
import { machineRunEnv, poolRunEnv } from './secrets.ts';
import { poolLimits } from './tokenPool.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import type { Config } from './config.ts';
import type { PlanUsage, SessionInfo } from '../shared/types.ts';

/**
 * w1112 (lothsahn, 2026-10-12: "The ops worker should not hold based on tokens, just like the dispatcher"): at 07:30Z
 * ops_worker deploy was refused with "lothsahn's Claude token pool is held: every token is at a limit (vault-lothsahn-1:
 * 5-hour 92% (>= 80) ...)". The pool's caps hold new worker jobs, never the ops worker; only a pool whose every token is used
 * up stops it, and the error says so.
 */

const NOW = Date.parse('2026-10-12T07:30:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const claudeTok = (c: string) => `sk-ant-oat01-${c.repeat(48)}`;
const DISP = claudeTok('d'); // vault-lothsahn-1: lothsahn's token, which the dispatcher is pinned to (its reserve sits on it)
const L2 = claudeTok('e');
const LOTH = { userId: 'lothsahn', displayName: 'Lothsahn' };
const usage = (session: number, weekly: number, sessionMin: number, weeklyDays = 3): PlanUsage => ({
  available: true,
  asOf: iso(NOW),
  models: [],
  session: { label: '5-hour', percent: session, resetsAt: iso(NOW + sessionMin * 60_000) },
  weekly: { label: 'weekly', percent: weekly, resetsAt: iso(NOW + weeklyDays * 86_400_000) },
});

async function until(what: string, cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function world(t: { after: (fn: () => void | Promise<void>) => void }, meters: Record<string, PlanUsage>, second = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-ops-pool-'));
  const keyFile = path.join(dir, 'vault.key');
  fs.writeFileSync(keyFile, newKeyText(), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const vault = new Vault({ file: path.join(dir, 'vault.json'), key: () => ({ file: keyFile }) });
  vault.add({ name: 'vault-lothsahn-1', kind: 'claude', value: DISP, owner: 'lothsahn', share: 'owner' });
  if (second) vault.add({ name: 'vault-lothsahn-2', kind: 'claude', value: L2, owner: 'lothsahn', share: 'owner' });
  const ctx: VaultContext = {
    vault,
    usageOf: (fp) => meters[fp],
    liveOn: () => 0,
    limits: () => poolLimits(undefined),
    reservedFor: (fp) => (fp === fingerprintOf(DISP) ? 'the dispatcher' : undefined),
    now: () => NOW,
    payer: () => 'lothsahn',
  };
  setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);
  const store = new Store(path.join(dir, 'data'));
  const sessions = new SessionManager({} as Config, store);
  const tokens: string[] = [];
  const ops = new OpsWorker({
    sessions,
    store,
    // What Agents.opsOptions does at each process start: the token from the pool of the person whose orchestrator asked.
    options: (info: SessionInfo) => {
      const env = poolRunEnv({ role: 'ops', personId: info.requestedBy?.userId, sessionId: info.id }, ctx).env;
      tokens.push(env.CLAUDE_CODE_OAUTH_TOKEN ?? '');
      return {};
    },
    tellOrchestrator: () => {},
    personTurn: () => true,
    file: path.join(dir, 'ops-worker.json'),
    now: () => NOW,
  });
  // The ops worker's turn may still be running when the test ends (a loaded runner): stop its process before the folder
  // goes, or its next transcript line lands in a deleted folder (w1758: ENOENT ops-worker.jsonl "after the test ended").
  t.after(async () => {
    ops.close();
    sessions.stopAll();
    store.flush();
    await store.saved();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const worker = () => machineRunEnv({ machines: {} } as never, { id: 'lothdesktop' }, { role: 'workers', requestedBy: LOTH, sessionId: 'w-new' }, ctx);
  return { ops, store, tokens, worker };
}
const lothOrch = { id: 'lo', kind: 'orchestrator', orchestratorRole: 'personal', requestedBy: LOTH } as SessionInfo;

test('w1112: ops_worker deploy goes through while the pool is held past the session cap; a new worker job is still held', async (t) => {
  // The 07:30Z picture: lothsahn's one token, the dispatcher's, at 92% of its 5-hour window (cap 80), resetting at 07:50Z.
  const w = world(t, { [fingerprintOf(DISP)]: usage(92, 40, 20) });
  assert.match(w.ops.deploy(lothOrch, 'deploy'), /may run fffctl update once/);
  await until('the deploy job starts its process', () => w.tokens.length > 0 && w.store.readTranscript(OPS_ID, 50).some((e) => e.kind === 'user'));
  assert.deepEqual(w.tokens, [DISP], 'the deploy job started a process, on lothsahn\'s token');
  assert.ok(w.store.readTranscript(OPS_ID, 50).some((e) => e.kind === 'user' && e.text.startsWith('[deploy] Lothsahn asked')));
  // The caps still hold a new worker job on the same pool, with the reason and the reset.
  assert.throws(
    w.worker,
    (e: unknown) => e instanceof PoolHeldError && /^lothsahn's Claude token pool is held: every token is at a limit \(vault-lothsahn-1: 5-hour 92% \(>= 80\): held until Mon 07:50Z\)/.test(e.message) && e.next === iso(NOW + 20 * 60_000),
  );
});

test("w1112: past the caps the ops worker takes the person's other token before the dispatcher's reserve; a worker waits", async (t) => {
  // vault-lothsahn-1 (the dispatcher's) is under every cap but inside its reserve (weekly 70% with 6 days left: buffer 30%);
  // vault-lothsahn-2 is held at 85%. A worker gets neither; the ops worker gets vault-lothsahn-2, keeping the dispatcher's buffer.
  const w = world(t, { [fingerprintOf(DISP)]: usage(10, 70, 200, 6), [fingerprintOf(L2)]: usage(85, 30, 60) }, true);
  w.ops.send(lothOrch, 'check m5', true);
  await until('the job starts its process', () => w.tokens.length > 0);
  assert.deepEqual(w.tokens, [L2]);
  assert.throws(w.worker, (e: unknown) => e instanceof PoolHeldError && /every token is at a limit \(.*inside the buffer kept for the dispatcher/.test(e.message));
});

test('w1112: only a used-up pool stops the ops worker, and the error says so plainly', (t) => {
  const w = world(t, { [fingerprintOf(DISP)]: usage(100, 60, 20) });
  assert.throws(
    () => w.ops.deploy(lothOrch, 'deploy'),
    (e: unknown) =>
      e instanceof PoolHeldError &&
      /^lothsahn's Claude token pool is used up, so the orchestration worker cannot start until a token resets \(Claude refuses a used-up token; the pool's limits never hold it, w1112\): every token is used up \(vault-lothsahn-1: 5-hour 100%, weekly 60%: used up until Mon 07:50Z\)/.test(e.message),
  );
  assert.deepEqual(w.tokens, []);
});
