import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { CATALOG } from './launch.ts';
import { clampArgs, withWarnings } from './forgiving.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import type { Config } from './config.ts';
import type { ProviderManager } from './providers.ts';
import type { Requester, UserInfo } from '../shared/types.ts';
import { useFakeVault } from './testVault.ts';

useFakeVault();
setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

/** w1869: a size or limit slip on a read-only tool is moved into range and warned about, never refused. */

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-limits-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'develop',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    intake: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  t.after(async () => {
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const ben = agents.orchestrators.personalFor(BEN);
  const dispatcher = sessions.get(agents.orchestrators.dispatcherId!);
  /** The tool as a belt hands it out, called the way the MCP server does: its schema first, then its handler. */
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = [...agents.orchestratorBelt(ben.info), ...agents.orchestratorBelt(dispatcher.info)].find((x) => x.name === name);
    if (!tool) throw new Error(`no belt has ${name}`);
    const parsed = z.object(tool.schema).safeParse(args);
    assert.ok(parsed.success, `${name}: the schema refused ${JSON.stringify(args)}: ${parsed.success ? '' : parsed.error.message}`);
    const r = await tool.handler(parsed.data);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  return { agents, ben, dispatcher, call };
}

test('w1869: clampArgs rounds and moves a number into its range, one warning for each that moved, and leaves the rest alone', () => {
  const c = clampArgs({ last: 1, limit: 9999, offset: -4, days: 7.4, q: 'x', gone: undefined }, { last: [5, 400], limit: [1, 50], offset: [0], days: [1, 120], gone: [1, 2], none: [1, 2] });
  assert.deepEqual(c.args, { last: 5, limit: 50, offset: 0, days: 7, q: 'x', gone: undefined });
  assert.equal(c.warnings.length, 3, c.warnings.join(' | '));
  assert.equal(clampArgs({ days: 7.6 }, { days: [1, 120] }).warnings.length, 0, 'rounding alone is no news');
  assert.match(c.warnings[0], /^last was 1, below the least allowed \(5\); used 5\.$/);
  assert.match(c.warnings[1], /^limit was 9999, over the most allowed \(50\); used 50\.$/);
  assert.match(c.warnings[2], /^offset was -4, below the least allowed \(0\); used 0\.$/);
  assert.equal(withWarnings('answer', []), 'answer');
  assert.equal(withWarnings('answer', ['a.', 'b.']), 'answer WARNING: a. b.');
});

test('w1869: agent_transcript with last: 1 succeeds, read as 5, and says so; last: 9999 reads 400; in range there is no warning', async (t) => {
  const env = setup(t);
  const id = env.ben.info.id;
  const low = await env.call('agent_transcript', { session_id: id, last: 1 });
  assert.equal(low.isError, false, low.text);
  assert.match(low.text, /WARNING: last was 1, below the least allowed \(5\); used 5\.$/);
  const high = await env.call('agent_transcript', { session_id: id, last: 9999 });
  assert.equal(high.isError, false, high.text);
  assert.match(high.text, /WARNING: last was 9999, over the most allowed \(400\); used 400\.$/);
  const fine = await env.call('agent_transcript', { session_id: id, last: 5 });
  assert.doesNotMatch(fine.text, /WARNING/);
  assert.doesNotMatch((await env.call('agent_transcript', { session_id: id })).text, /WARNING/);
});

test('w1869: search_transcripts, spend_report, cleanup_log, max_activity and ffbox_activity take a limit out of range and warn', async (t) => {
  const env = setup(t);
  const search = await env.call('search_transcripts', { query: 'anything', limit: 0 });
  assert.equal(search.isError, false, search.text);
  assert.match(search.text, /WARNING: limit was 0, below the least allowed \(1\); used 1\.$/);
  const spend = await env.call('spend_report', { days: 500, top: 0 });
  assert.equal(spend.isError, false, spend.text);
  assert.match(spend.text, /WARNING: days was 500, over the most allowed \(120\); used 120\. top was 0, below the least allowed \(1\); used 1\.$/);
  const log = await env.call('cleanup_log', { passes: 99 });
  assert.equal(log.isError, false, log.text);
  assert.match(log.text, /WARNING: passes was 99, over the most allowed \(20\); used 20\.$/);
  const max = await env.call('max_activity', { limit: 1000 });
  assert.match(max.text, /WARNING: limit was 1000, over the most allowed \(200\); used 200\.$/);
  const ffbox = await env.call('ffbox_activity', { limit: 0, offset: -1 });
  assert.match(ffbox.text, /WARNING: limit was 0, below the least allowed \(1\); used 1\. offset was -1, below the least allowed \(0\); used 0\.$/);
});

test("w1869: unity's log lines are a loose number in the schema", async (t) => {
  const env = setup(t);
  const tool = env.agents.orchestratorBelt(env.dispatcher.info).find((x) => x.name === 'unity')!;
  for (const lines of [0, 5000]) assert.ok(z.object(tool.schema).safeParse({ action: 'log', sandbox: 'x/y', lines }).success, `lines ${lines}`);
});

test('w1869: read_work, portal_logs and list_ffbox_files take a limit and offset out of range and warn; their schemas let them through', async (t) => {
  const env = setup(t);
  const slip = { limit: 0, offset: -2 };
  for (const name of ['read_work', 'portal_logs', 'list_ffbox_files'] as const) {
    assert.ok(z.object(CATALOG[name] as z.ZodRawShape).safeParse({ what: 'reports', ...slip, limit: 100000 }).success, `${name}: a slip passes the schema`);
  }
  const work = env.agents.readWorkFor(env.ben.info.id, { ...slip });
  assert.match(work, /WARNING: limit was 0, below the least allowed \(1\); used 1\. offset was -2, below the least allowed \(0\); used 0\.$/);
  assert.match(env.agents.readWorkFor(env.ben.info.id, { limit: 500 }), /WARNING: limit was 500, over the most allowed \(50\); used 50\.$/);
  const logs = await env.agents.portalLogsFor({ ...slip });
  assert.match(logs, /WARNING: limit was 0, below the least allowed \(1\); used 1\. offset was -2, below the least allowed \(0\); used 0\.$/);
  const asked: Record<string, number | string>[] = [];
  env.agents.providers = { query: async (_kind: string, args: Record<string, number | string>) => (asked.push(args), { live: true, at: 'now', data: { reports: [] } }) } as unknown as ProviderManager;
  const files = await (env.agents as unknown as { listFfboxFiles(a: Record<string, unknown>): Promise<string> }).listFfboxFiles({ what: 'reports', limit: 100000, offset: 100000000 });
  assert.match(files, /WARNING: limit was 100000, over the most allowed \(500\); used 500\. offset was 100000000, over the most allowed \(100000\); used 100000\.$/);
  assert.equal(asked[0].limit, 200, 'FFBox lists at most 200 reports a page, which ffboxReportsArgs holds to');
  assert.equal(asked[0].offset, 100000);
});

test("w1869: orchestrator_transcript (the remote API's) takes last: 1 as 5 and says so", async (t) => {
  const env = setup(t);
  const tool = env.agents.remoteToolSpecs('test', BEN, { who: BEN, keyName: 'test', bound: true } as never).find((x) => x.name === 'orchestrator_transcript')!;
  const args = { last: 1 };
  assert.ok(z.object(tool.schema).safeParse(args).success);
  const r = await tool.handler(args);
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /WARNING: last was 1, below the least allowed \(5\); used 5\.$/);
});
