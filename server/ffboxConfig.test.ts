// set_ffbox_config (w2672): one of FFBox's live settings changed over the connector's `set_config` query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderManager } from './providers.ts';
import { PROVIDER_QUERIES, QUERY_LIMITS, mintProviderToken, tokenSha256 } from './providerProtocol.ts';
import { FFBOX_SETTABLE_KEYS, ffboxConfigArgs, setFfboxConfig } from './ffboxConfig.ts';
import { USER_ASKED_TOOLS } from './belts.ts';
import { TOOL_MANIFEST } from './toolManifest.ts';
import { MockConnector } from '../e2e/mockConnector.ts';
import type { Config } from './config.ts';

async function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffbox-config-'));
  const token = mintProviderToken();
  const cfg = { dataDir, providers: { ffbox: { enabled: true, tokenSha256: tokenSha256(token) } } } as unknown as Config;
  const pm = new ProviderManager(cfg);
  pm.statusPollMs = 0;
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => pm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const c = new MockConnector(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, token);
  await c.hello({ protocol: 2 });
  t.after(() => {
    c.close();
    pm.close();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { pm, c };
}

type Q = { id: string; what: string; args?: Record<string, string> };
function onQuery(c: MockConnector, answer: (q: Q) => void) {
  const timer = setInterval(() => {
    for (let i = c.received.findIndex((m) => m.type === 'query'); i >= 0; i = c.received.findIndex((m) => m.type === 'query')) answer(c.received.splice(i, 1)[0] as Q);
  }, 10);
  return () => clearInterval(timer);
}

test('set_config is a query the portal asks, waits 20 s for, and the tool is a person-asked admin tool', () => {
  assert.ok((PROVIDER_QUERIES as readonly string[]).includes('set_config'));
  assert.equal(QUERY_LIMITS.timeoutMsByQuery.set_config, 20_000);
  assert.ok(USER_ASKED_TOOLS.has('set_ffbox_config'), "the dispatcher's runs only when a person asked");
  assert.deepEqual(TOOL_MANIFEST.set_ffbox_config, { group: 'admin', kinds: ['dispatcher', 'personal'] }, 'orchestrators only: no worker and no /mcp key');
  assert.deepEqual([...FFBOX_SETTABLE_KEYS], ['subscription.new_conversation_hold_pct', 'subscription.review_hold_pct']);
});

test('the args: a settable key and a 0-1 number or null with a reason, or a revert id; never a secret or a path', () => {
  assert.deepEqual(ffboxConfigArgs({ key: 'subscription.review_hold_pct', value: 0.76, reason: 'demo', by: 'Lothsahn (lothsahn)' }), { args: { key: 'subscription.review_hold_pct', value: '0.76', reason: 'demo', by: 'Lothsahn (lothsahn)' } });
  assert.deepEqual(ffboxConfigArgs({ key: 'subscription.review_hold_pct', value: null, reason: 'off' }), { args: { key: 'subscription.review_hold_pct', value: 'null', reason: 'off', by: '' } });
  assert.deepEqual(ffboxConfigArgs({ revert: 's0123456789', reason: 'back' }), { args: { revert: 's0123456789', reason: 'back', by: '' } });
  assert.deepEqual(ffboxConfigArgs({}), { args: { by: '' } }, 'no key: the list');
  const bad = (input: Parameters<typeof ffboxConfigArgs>[0], re: RegExp) => assert.match(String((ffboxConfigArgs(input) as { error?: string }).error), re, JSON.stringify(input));
  for (const key of ['secrets.env', '../secrets.env', 'ANTHROPIC_API_KEY', 'app_token', 'operators.lothsahn', 'github.pr_token', 'subscription']) bad({ key, value: 0.5, reason: 'x' }, /changes only/);
  bad({ key: 'subscription.review_hold_pct', value: 1.5, reason: 'x' }, /value:/);
  bad({ key: 'subscription.review_hold_pct', value: -0.1, reason: 'x' }, /value:/);
  bad({ key: 'subscription.review_hold_pct', value: Number.NaN, reason: 'x' }, /value:/);
  bad({ key: 'subscription.review_hold_pct', value: 0.5 }, /reason:/);
  bad({ revert: 'nope', reason: 'x' }, /revert:/);
  bad({ key: 'subscription.review_hold_pct', revert: 's0123456789', reason: 'x' }, /not both/);
});

test('setFfboxConfig: the query goes out, the answer reads old, new and the effective value back', async (t) => {
  const { pm, c } = await setup(t);
  const seen: Q[] = [];
  t.after(
    onQuery(c, (q) => {
      seen.push(q);
      c.send({ type: 'query_result', id: q.id, what: 'set_config', ok: true, at: '2026-10-31T10:00:00Z', data: { key: 'subscription.review_hold_pct', old: 0.75, new: 0.76, effective: 0.76, change: 's0123456789', at: '2026-10-31T10:00:00Z', by: 'x', restart: false, prev: 'config.json.prev' } });
    }),
  );
  const text = await setFfboxConfig(pm, { key: 'subscription.review_hold_pct', value: 0.76, reason: 'demo', by: 'Lothsahn (lothsahn)' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].what, 'set_config');
  assert.deepEqual(seen[0].args, { key: 'subscription.review_hold_pct', value: '0.76', reason: 'demo', by: 'Lothsahn (lothsahn)' });
  assert.match(text, /^FFBox: subscription\.review_hold_pct 0\.75 -> 0\.76; effective now 0\.76 \(read back live\), change s0123456789/);
  assert.match(text, /no restart/);
  assert.match(text, /revert "s0123456789"/);
});

test('setFfboxConfig: a refusal says FFBox changed nothing, a timeout says it may have, a list is rendered', async (t) => {
  const { pm, c } = await setup(t);
  let mode = 'refused';
  t.after(
    onQuery(c, (q) => {
      if (mode === 'refused') c.send({ type: 'query_result', id: q.id, what: 'set_config', ok: false, error: 'refused', reason: 'subscription.review_hold_pct: value: 1.5 is outside 0 to 1' });
      else if (mode === 'timeout') c.send({ type: 'query_result', id: q.id, what: 'set_config', ok: false, error: 'timeout' });
      else c.send({ type: 'query_result', id: q.id, what: 'set_config', ok: true, at: '2026-10-31T10:00:00Z', data: { settable: [{ key: 'subscription.review_hold_pct', kind: 'fraction', min: 0, max: 1, what: 'a review waits', effective: 0.75 }], file: 'config.json', recent: [] } });
    }),
  );
  await assert.rejects(setFfboxConfig(pm, { key: 'subscription.review_hold_pct', value: 0.5, reason: 'x' }), /^Error: FFBox changed nothing: refused \(subscription\.review_hold_pct: value: 1\.5 is outside 0 to 1\)\.$/);
  mode = 'timeout';
  await assert.rejects(setFfboxConfig(pm, { key: 'subscription.review_hold_pct', value: 0.5, reason: 'x' }), /may have been made/);
  mode = 'list';
  const text = await setFfboxConfig(pm, {});
  assert.match(text, /- subscription\.review_hold_pct = 0\.75 \(fraction 0 to 1\): a review waits/);
  assert.match(text, /No changes yet\./);
});

test('a call the checks refuse never reaches FFBox', async (t) => {
  const { pm, c } = await setup(t);
  await assert.rejects(setFfboxConfig(pm, { key: 'secrets.env', value: 0.5, reason: 'x' }), /changes only/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.received.filter((m) => m.type === 'query').length, 0);
});
