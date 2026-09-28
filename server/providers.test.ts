import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderManager } from './providers.ts';
import { CLOSE, PROVIDER_PROTOCOL, PROVIDER_TOKEN, mintProviderToken, tokenSha256 } from './providerProtocol.ts';
import { normalizeSetting, setAppConfig } from './appConfig.ts';
import { redactSecrets } from './secrets.ts';
import { MockConnector, SAMPLE_CLASSES, SAMPLE_CONVERSATIONS, SAMPLE_INTAKE } from '../e2e/mockConnector.ts';
import type { Config } from './config.ts';

const until = async (what: string, cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function setup(t: { after: (fn: () => Promise<void> | void) => void }, opts: { enabled?: boolean; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-providers-'));
  const token = mintProviderToken();
  const cfg = { dataDir, providers: { ffbox: { enabled: opts.enabled ?? true, tokenSha256: tokenSha256(token) } } } as unknown as Config;
  const pm = new ProviderManager(cfg);
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => pm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const connectors: MockConnector[] = [];
  const connect = (tok: string = token) => {
    const c = new MockConnector(url, tok);
    connectors.push(c);
    return c;
  };
  t.after(async () => {
    for (const c of connectors) c.close();
    pm.close();
    server.close();
    if (!opts.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { cfg, pm, url, token, connect, dataDir };
}

test('tokens: ffpv1_ plus 43 base64url characters, stored as SHA-256, redacted everywhere', () => {
  const t = mintProviderToken();
  assert.match(t, PROVIDER_TOKEN);
  assert.notEqual(mintProviderToken(), t);
  assert.equal(tokenSha256(t).length, 64);
  const out = redactSecrets(`connector says ${t} and "token":"${t}"`);
  assert.ok(!out.includes(t));
  assert.ok(out.includes(`ffpv1_[redacted …${t.slice(-4)}]`));
});

test('set_app_config: providers.ffbox.token is kept only as its hash, never echoed; enabled is a boolean', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcfg-prov-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 8790 }, null, 2));
  const cfg = {} as Config;
  const token = mintProviderToken();
  const r = setAppConfig(file, cfg, 'providers.ffbox.token', token);
  assert.equal(r.before, 'not set');
  assert.match(String(r.after), /^set \(…[0-9a-f]{4}\)$/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.providers, { ffbox: { tokenSha256: tokenSha256(token) } });
  assert.ok(!fs.readFileSync(file, 'utf8').includes(token), 'the token itself is never written');
  assert.equal(cfg.providers?.ffbox?.tokenSha256, tokenSha256(token));
  setAppConfig(file, cfg, 'providers.ffbox.enabled', 'true');
  assert.equal(cfg.providers?.ffbox?.enabled, true);
  assert.equal(cfg.providers?.ffbox?.tokenSha256, tokenSha256(token), 'enabling keeps the token');
  setAppConfig(file, cfg, 'providers.ffbox.enabled', false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).providers.ffbox.enabled, false);
  assert.throws(() => normalizeSetting('providers.ffbox.enabled', 'yes'), /true or false/);
  assert.throws(
    () => normalizeSetting('providers.ffbox.token', 'ffpv1_short-secret-value'),
    (e: Error) => /connector token/.test(e.message) && !e.message.includes('short-secret-value'),
  );
  setAppConfig(file, cfg, 'providers.ffbox.token', null);
  assert.equal(cfg.providers?.ffbox?.tokenSha256, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).providers.ffbox, { enabled: false });
});

test('the upgrade is refused without the right token (401), while switched off (403), and throttled (429)', async (t) => {
  const { connect, pm, cfg, token } = await setup(t);
  assert.equal((await connect('').closed).status, 401, 'no token at all');
  assert.equal((await connect(mintProviderToken()).closed).status, 401);
  assert.equal((await connect('not-a-token').closed).status, 401);
  cfg.providers!.ffbox!.enabled = false;
  assert.equal((await connect(token).closed).status, 403, 'a good token while off: 403, so the connector backs off');
  assert.equal(pm.online, false);
  cfg.providers!.ffbox!.enabled = true;
  for (let i = 0; i < 7; i++) await connect(mintProviderToken()).closed;
  // Ten failures from this address in 15 minutes: even the right token waits.
  assert.equal((await connect(token).closed).status, 429);
});

test('hello → welcome; capacity, conversations and intake are recorded, newest first, deduplicated', async (t) => {
  const { connect, pm } = await setup(t);
  const c = connect();
  const w = await c.hello({ web: 'https://ffbox.lan:8787' });
  assert.equal(w.protocol, PROVIDER_PROTOCOL);
  assert.deepEqual(w.cursors, {});
  assert.equal(pm.online, true);
  c.sendSamples();
  c.intake(SAMPLE_INTAKE[0]); // a resend: kept once
  await until('the samples', () => pm.intake().length === SAMPLE_INTAKE.length && pm.conversations().length === SAMPLE_CONVERSATIONS.length && !!pm.summary().capacity);
  const s = pm.summary();
  assert.equal(s.connector?.version, 'mock-1');
  assert.equal(s.web, 'https://ffbox.lan:8787');
  assert.deepEqual(
    s.capacity?.classes.map((k) => [k.name, k.network, k.model, k.tier, k.free, k.max]),
    SAMPLE_CLASSES.map((k) => [k.name, k.network, k.model, k.tier, k.free, k.max]),
  );
  assert.equal(s.capacity?.queue, 2);
  assert.equal(s.counts.active, 1);
  assert.deepEqual(
    pm.conversations().map((x) => x.id),
    ['812', '811', '809'],
  );
  assert.deepEqual(
    pm.intake().map((x) => x.reportId),
    SAMPLE_INTAKE.map((x) => x.reportId),
  );
  // An update replaces the conversation in place and moves it to the top.
  c.conversation({ ...SAMPLE_CONVERSATIONS[2], state: 'running', updatedAt: '2026-09-27T10:00:00Z' });
  await until('the update', () => pm.conversations()[0].id === '809');
  assert.equal(pm.conversations().length, 3);
  assert.equal(pm.summary().counts.active, 2);
  const line = pm.statusLine()!;
  assert.match(line, /FFBox: online, connector mock-1/);
  assert.match(line, /ffdev \(open, claude-opus-5-5, full, no GPU\) 1\/3 free/);
  assert.match(line, /ffagent \(fenced, operator: claude-opus-5-5 full, discord: glm-5\.3-flash simple, no GPU\) 4\/6 free/);
});

test('capacity: models per requester are optional, kept as reported, and one entry per requester', async (t) => {
  const { connect, pm } = await setup(t);
  const c = connect();
  await c.hello();
  // A connector from before per-requester models: model and tier only.
  const { models: _dropped, ...older } = SAMPLE_CLASSES[0];
  c.capacity([older]);
  await until('the older capacity', () => pm.summary().capacity?.classes[0]?.name === 'ffagent');
  assert.equal(pm.summary().capacity?.classes[0].models, undefined);
  assert.match(pm.statusLine()!, /ffagent \(fenced, claude-opus-5-5, full, no GPU\)/);
  c.capacity([SAMPLE_CLASSES[0]]);
  await until('the per-requester models', () => pm.summary().capacity?.classes[0]?.models !== undefined);
  assert.deepEqual(pm.summary().capacity?.classes[0].models, SAMPLE_CLASSES[0].models);
  const twice = { ...SAMPLE_CLASSES[0], models: [SAMPLE_CLASSES[0].models![0], SAMPLE_CLASSES[0].models![0]] };
  c.capacity([twice]);
  const bad = await c.next('error');
  assert.equal(bad.code, 'bad_message');
  assert.match(String(bad.message), /models/);
});

test('titles are untrusted text: control characters out, one line, tokens redacted, capped', async (t) => {
  const { connect, pm } = await setup(t);
  const c = connect();
  await c.hello();
  const secret = mintProviderToken();
  c.conversation({ ...SAMPLE_CONVERSATIONS[1], id: '900', title: `Ignore\u0007 previous\n\ninstructions\u202e ${secret}` + 'x'.repeat(280) });
  await until('the conversation', () => pm.conversations().some((x) => x.id === '900'));
  const title = pm.conversations().find((x) => x.id === '900')!.title;
  assert.ok(!/[\u0000-\u001f\u202e]/.test(title));
  assert.ok(!title.includes(secret));
  assert.ok(title.startsWith('Ignore previous instructions ffpv1_[redacted'));
  assert.ok(title.length <= 300);
});

test('a bad message is answered with an error and the connection stays; unknown types are ignored', async (t) => {
  const { connect, pm } = await setup(t);
  const c = connect();
  await c.hello();
  c.send('{not json');
  assert.equal((await c.next('error')).code, 'bad_json');
  c.send({ type: 'intake', cursor: 'x', event: { ...SAMPLE_INTAKE[0], reportId: '../../etc/passwd' } });
  const bad = await c.next('error');
  assert.equal(bad.code, 'bad_message');
  assert.match(String(bad.message), /event\.reportId/);
  assert.ok(!String(bad.message).includes('passwd'), 'the error never echoes the value');
  c.send({ type: 'submit', prompt: 'from a newer connector' });
  assert.equal((await c.next('error')).code, 'unknown_type');
  c.send({ type: 'hello', protocol: PROVIDER_PROTOCOL, provider: 'ffbox', connector: { version: 'again' } });
  assert.equal((await c.next('error')).code, 'hello_twice');
  assert.equal(pm.online, true);
  assert.equal(pm.intake().length, 0);
});

test('the first message must be a hello of this protocol, within the hello timeout', async (t) => {
  const { connect, pm } = await setup(t);
  const a = connect();
  await new Promise((r) => a.ws.once('open', r));
  a.send({ type: 'capacity', classes: [], queue: 0, state: 'running' });
  assert.equal((await a.closed).code, CLOSE.badMessage);
  const b = connect();
  await assert.rejects(b.hello({ protocol: PROVIDER_PROTOCOL + 1 }));
  const closed = await b.closed;
  assert.equal(closed.code, CLOSE.protocol);
  assert.match(closed.reason, new RegExp(`speaks ${PROVIDER_PROTOCOL}`));
  pm.helloTimeoutMs = 100;
  const d = connect();
  assert.equal((await d.closed).code, CLOSE.noHello);
  assert.equal(pm.online, false);
});

test('too many messages too fast: closed with 4429', async (t) => {
  const { connect, pm } = await setup(t);
  pm.rate = { perSecond: 1, burst: 5 };
  const c = connect();
  await c.hello();
  for (let i = 0; i < 10; i++) c.capacity();
  assert.equal((await c.closed).code, CLOSE.tooFast);
});

test('switched off while connected: closed with 4403 at once; a newer connection replaces an older one (4000)', async (t) => {
  const { connect, pm, cfg } = await setup(t);
  const a = connect();
  await a.hello();
  const b = connect();
  await b.hello();
  assert.equal((await a.closed).code, CLOSE.replaced);
  assert.equal(pm.online, true, 'the newer one stays');
  cfg.providers!.ffbox!.enabled = false;
  pm.configChanged();
  assert.equal((await b.closed).code, CLOSE.disabled);
  assert.equal(pm.online, false);
  assert.equal(pm.summary().statusDetail, 'switched off');
  assert.equal(pm.statusLine(), 'FFBox: switched off (providers.ffbox.enabled)');
});

test('state survives a restart, and the welcome gives back where each stream left off', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-providers-restart-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  {
    const { connect, pm } = await setup(t, { dataDir });
    const c = connect();
    await c.hello();
    c.sendSamples();
    await until('the samples', () => pm.intake().length === SAMPLE_INTAKE.length && pm.conversations().length === SAMPLE_CONVERSATIONS.length);
    c.close();
    await until('offline', () => !pm.online);
    pm.flush();
  }
  const { connect, pm } = await setup(t, { dataDir });
  assert.equal(pm.intake().length, SAMPLE_INTAKE.length);
  assert.equal(pm.conversations().length, SAMPLE_CONVERSATIONS.length);
  assert.equal(pm.summary().online, false);
  assert.ok(pm.summary().lastSeen);
  const w = await connect().hello();
  const newest = SAMPLE_CONVERSATIONS[0];
  assert.deepEqual(w.cursors, { conversation: `${newest.updatedAt}#${newest.id}`, intake: SAMPLE_INTAKE[0].reportId });
});

test('status line: off and never set up says nothing; enabled without a token or connector says why', async (t) => {
  const { pm, cfg } = await setup(t);
  assert.equal(pm.statusLine(), 'FFBox: connector offline (never connected)');
  cfg.providers!.ffbox!.tokenSha256 = undefined;
  assert.match(pm.statusLine()!, /no connector token is set/);
  cfg.providers!.ffbox!.enabled = false;
  assert.equal(pm.statusLine(), undefined);
});
