// /machine/ssh over HTTP (server/machineSshHttp.ts, w568): a worker installer gets the portal's key line and registers its
// host keys, with its machine's own credential only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { machineSshHttp, type MachineSshDeps } from './machineSshHttp.ts';
import type { MachineSsh } from './machineSsh.ts';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGgE0GjCLsOOdLNBCR5KKXguNoZCX0Mh7C3tZbQzCDQx fff-portal@fff-portal';
const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJPzhFYZX4GtbGkBP2Fl8RqwkZaXjQ9fUWN9P+p+/OX3';
const GOOD = 'Bearer ffm_m3_good';

async function serve(over: Partial<MachineSshDeps> = {}) {
  const registered: { id: string; ssh: MachineSsh }[] = [];
  const d: MachineSshDeps = {
    machineOf: (h) => (h === GOOD ? 'm3' : undefined),
    publicKey: () => PUB,
    tailnetAddress: async () => '100.124.172.97',
    register: async (id, ssh) => (registered.push({ id, ssh }), { host: `${ssh.user}@${ssh.host}`, reachable: true, detail: 'ok' }),
    ...over,
  };
  const server = http.createServer((req, res) => void machineSshHttp(d, req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/machine/ssh`;
  const call = async (init: RequestInit & { auth?: string } = {}) => {
    const r = await fetch(url, { ...init, headers: { ...(init.auth ? { authorization: init.auth } : {}), 'content-type': 'application/json' } });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { call, registered, close: () => server.close() };
}

test('machine ssh http: only a machine\'s own credential gets the key line or registers anything', async (t) => {
  const s = await serve();
  t.after(s.close);
  assert.equal((await s.call()).status, 401);
  assert.equal((await s.call({ auth: 'Bearer ffm_m3_wrong' })).status, 401);
  assert.equal((await s.call({ method: 'POST', auth: 'Bearer ffm_m3_wrong', body: JSON.stringify({ user: 'b', host: 'm3', hostKeys: [ED] }) })).status, 401);
  assert.deepEqual(s.registered, []);
});

test('machine ssh http: GET gives the portal\'s key, restricted to its tailnet address; POST pins the host keys and says whether ssh gets in', async (t) => {
  const s = await serve();
  t.after(s.close);
  const g = await s.call({ auth: GOOD });
  assert.deepEqual(g, { status: 200, body: { publicKey: PUB, from: '100.124.172.97', authorizedKey: `from="100.124.172.97",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${PUB}` } });
  const p = await s.call({ method: 'POST', auth: GOOD, body: JSON.stringify({ user: 'benryding', host: 'm3', hostKeys: [ED] }) });
  assert.deepEqual(p, { status: 200, body: { host: 'benryding@m3', reachable: true, detail: 'ok' } });
  assert.deepEqual(s.registered.map((r) => [r.id, r.ssh.user, r.ssh.host, r.ssh.hostKeys]), [['m3', 'benryding', 'm3', [ED]]]);
  // A bad body is refused before anything is kept.
  assert.equal((await s.call({ method: 'POST', auth: GOOD, body: JSON.stringify({ user: 'b', host: 'm3', hostKeys: ['nope'] }) })).status, 400);
  assert.equal((await s.call({ method: 'POST', auth: GOOD, body: 'not json' })).status, 400);
  assert.equal((await s.call({ method: 'PUT', auth: GOOD })).status, 405);
  assert.equal(s.registered.length, 1);
});

test('machine ssh http: no portal key is a 404 the installer reports; no tailnet address leaves out from=; a dry-run portal keeps nothing', async (t) => {
  const s = await serve({ publicKey: () => undefined });
  t.after(s.close);
  assert.equal((await s.call({ auth: GOOD })).status, 404);
  const s2 = await serve({ tailnetAddress: async () => undefined, refused: () => 'this portal is a dry run' });
  t.after(s2.close);
  assert.equal((await s2.call({ auth: GOOD })).body.authorizedKey, `no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${PUB}`);
  assert.deepEqual(await s2.call({ method: 'POST', auth: GOOD, body: JSON.stringify({ user: 'b', host: 'm3', hostKeys: [ED] }) }), { status: 409, body: { error: 'this portal is a dry run' } });
  assert.deepEqual(s2.registered, []);
});
