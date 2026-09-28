import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderManager } from './providers.ts';
import {
  AcceptedSchema,
  DiagnoseSchema,
  RefusedSchema,
  SubmitSchema,
  WORK_MESSAGES,
  WorkReplySchema,
  acceptsWork,
  buildDiagnose,
  buildStop,
  buildSubmit,
  mintProviderToken,
  tokenSha256,
} from './providerProtocol.ts';
import { MockConnector } from '../e2e/mockConnector.ts';
import type { Config } from './config.ts';

/**
 * The phase 3 work messages (docs/ffbox-connector-contract.md, "Work messages"): each names the person it is
 * for, `requestedBy`, and carries no credential; FFBox picks the account by it or refuses.
 */

const LOTH = { userId: 'lothsahn', displayName: 'Lothsahn' };
const BEN = { userId: 'ben', displayName: 'Ben' };
const OAUTH = 'sk-ant-oat01-' + 'x'.repeat(60) + 'abcd';
const base = { id: 'fff-1', requestedBy: LOTH, trigger: 'person' as const, title: 'Fix the belt', prompt: 'Fix belt splitter balance.', untrustedInput: false };

test('submit: carries requestedBy and the trigger, fenced by default', () => {
  const m = buildSubmit(base);
  assert.equal(m.type, 'submit');
  assert.deepEqual(m.requestedBy, LOTH);
  assert.equal(m.trigger, 'person');
  assert.equal(m.class, 'fenced');
  // Automatic work (intake triage) is attributed to the configured system payer.
  assert.equal(buildSubmit({ ...base, requestedBy: BEN, trigger: 'automatic' }).trigger, 'automatic');
});

test('submit: no credential can ride along; the prompt and title are redacted', () => {
  assert.throws(() => buildSubmit({ ...base, requestedBy: { ...LOTH, token: OAUTH } as never }), /Unrecognized key|token/, 'requestedBy is an id and a name, nothing else');
  assert.throws(() => buildSubmit({ ...base, claudeToken: OAUTH } as never), /Unrecognized key|claudeToken/, 'no unknown field at the top level either');
  assert.throws(() => buildSubmit({ ...base, requestedBy: undefined } as never), /requestedBy/, 'every piece of work is for someone');
  assert.throws(() => buildSubmit({ ...base, requestedBy: { userId: 'x', displayName: 'X' } }), /userId/, 'a login name: 2-32 characters');
  assert.throws(() => buildSubmit({ ...base, requestedBy: { userId: 'loth', displayName: 'Loth\nsahn' } }), /one plain line/);
  const m = buildSubmit({ ...base, title: `use ${OAUTH}`, prompt: `the token is ${OAUTH}, and ffpv1_${'a'.repeat(43)}` });
  assert.equal(JSON.stringify(m).includes(OAUTH), false);
  assert.match(m.prompt, /sk-ant-oat01-\[redacted …abcd\]/);
  assert.match(m.prompt, /ffpv1_\[redacted …aaaa\]/);
  assert.match(m.title, /redacted/);
});

test('submit: untrusted input is never sent to the open class; limits hold', () => {
  assert.throws(() => buildSubmit({ ...base, untrustedInput: true, class: 'open' }), /untrustedInput work runs fenced/);
  assert.equal(buildSubmit({ ...base, untrustedInput: true }).class, 'fenced');
  assert.equal(buildSubmit({ ...base, class: 'open' }).class, 'open');
  assert.throws(() => buildSubmit({ ...base, prompt: 'x'.repeat(48_001) }), /prompt/);
  assert.throws(() => buildSubmit({ ...base, id: 'has space' }), /id/);
  assert.throws(() => buildSubmit({ ...base, branch: 'a b' }), /branch/);
  assert.equal(SubmitSchema.safeParse({ ...base, type: 'submit', trigger: 'cron' }).success, false, 'person or automatic');
});

test('diagnose and stop: also for someone; report ids pattern-checked', () => {
  const d = buildDiagnose({ id: 'fff-2', requestedBy: BEN, trigger: 'automatic', reportIds: ['20260927T090000Z-desync-3a9f01c2d4'], key: 'desync:0.50.0:minerBots+census' });
  assert.equal(d.type, 'diagnose');
  assert.deepEqual(d.requestedBy, BEN);
  assert.throws(() => buildDiagnose({ id: 'fff-2', requestedBy: BEN, trigger: 'automatic', reportIds: ['../../etc/passwd'] }), /reportIds/);
  assert.throws(() => buildDiagnose({ id: 'fff-2', requestedBy: BEN, trigger: 'automatic', reportIds: [] }), /reportIds/);
  assert.equal(DiagnoseSchema.safeParse({ type: 'diagnose', id: 'x', trigger: 'automatic', reportIds: ['20260927T090000Z-desync-3a9f01c2d4'] }).success, false, 'no requestedBy: invalid');
  assert.deepEqual(buildStop({ id: 'fff-3', requestedBy: LOTH, conversation: '812' }), { type: 'stop', id: 'fff-3', requestedBy: LOTH, conversation: '812' });
});

test("the connector's replies: accepted names whose account it billed; refused says why, including no account for that person", () => {
  assert.equal(AcceptedSchema.parse({ type: 'accepted', ref: 'fff-1', conversation: '813', billedTo: 'lothsahn' }).billedTo, 'lothsahn');
  assert.equal(AcceptedSchema.safeParse({ type: 'accepted', ref: 'fff-1', conversation: '813' }).success, false, 'billedTo is required');
  for (const reason of ['unknown_requester', 'no_account']) {
    assert.equal(RefusedSchema.parse({ type: 'refused', ref: 'fff-1', reason, message: 'no fff:lothsahn operator' }).reason, reason);
  }
  assert.equal(WorkReplySchema.safeParse({ type: 'refused', ref: 'fff-1', reason: 'charged_someone_else' }).success, false);
});

test('hello.accepts: a phase 1 connector takes no work; one that lists the work messages is recorded as taking them', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-provwork-'));
  const token = mintProviderToken();
  const pm = new ProviderManager({ dataDir, providers: { ffbox: { enabled: true, tokenSha256: tokenSha256(token) } } } as unknown as Config);
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => pm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const conns: MockConnector[] = [];
  t.after(() => {
    for (const c of conns) c.close();
    pm.close();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const c1 = new MockConnector(url, token);
  conns.push(c1);
  await c1.hello();
  assert.equal(pm.summary().accepts, undefined);
  assert.equal(acceptsWork(pm.summary().accepts, 'submit'), false);
  c1.close();
  const c2 = new MockConnector(url, token);
  conns.push(c2);
  await c2.hello({ accepts: [...WORK_MESSAGES, 'future_thing'] });
  assert.deepEqual(pm.summary().accepts, ['submit', 'diagnose', 'stop', 'future_thing']);
  assert.equal(acceptsWork(pm.summary().accepts, 'submit'), true);
});
