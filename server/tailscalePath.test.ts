// w5897: the Tailscale path line of a slow or cut update bundle (server/tailscalePath.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_COOLDOWN_MS, TailscalePathProbe, findPeer, pathLine, pingSummary, shortKey, slowBundleReason, slowRunningReason, type Run } from './tailscalePath.ts';

const KEY_HEX = '2c6239ee' + '0'.repeat(56);
const KEY = `nodekey:${KEY_HEX}`;
const SHORT = `[${Buffer.from(KEY_HEX, 'hex').toString('base64').slice(0, 5)}]`;

const status = JSON.stringify({
  Self: { HostName: 'fff-portal', PublicKey: `nodekey:${'1'.repeat(64)}` },
  Peer: {
    [KEY]: { PublicKey: KEY, HostName: 'BEAST', DNSName: 'beast.tail1234.ts.net.', TailscaleIPs: ['100.101.2.3', 'fd7a:115c:a1e0::1'], CurAddr: '', Relay: 'ord', RxBytes: 1234, TxBytes: 5678, LastHandshake: '2026-11-26T10:00:00.123Z', Online: true, Active: true },
    other: { PublicKey: `nodekey:${'2'.repeat(64)}`, HostName: 'm5', DNSName: 'm5.tail1234.ts.net.', TailscaleIPs: ['100.64.0.9'], CurAddr: '203.0.113.5:41641', Relay: 'sea', Online: true },
  },
});

test('a short key is the 5 base64 characters tailscaled logs, and never more', () => {
  assert.equal(shortKey(KEY), SHORT);
  assert.equal(SHORT.length, 7);
  assert.equal(shortKey('nope'), '[?]');
});

test('the peer is found by its address, else by its name', () => {
  assert.equal(findPeer(status, { addr: '100.101.2.3', machineId: 'whatever' })?.host, 'beast');
  const p = findPeer(status, { machineId: 'beast' });
  assert.deepEqual(p, { host: 'beast', key: SHORT, ip: '100.101.2.3', online: true, active: true, curAddr: '', relay: 'ord', peerRelay: '', lastHandshake: '2026-11-26T10:00:00.123Z', rx: 1234, tx: 5678 });
  assert.equal(findPeer(status, { machineId: 'biscuit' }), undefined);
  assert.equal(findPeer('not json', { machineId: 'beast' }), undefined);
});

test('which bundles are slow: a cut always, a slow one only when long or large enough to judge', () => {
  assert.match(slowBundleReason({ start: 0, sent: 1000, size: 9000, ms: 300_000, finished: false })!, /was cut after 1000 of 9000 bytes in 300\.0 s \(0 KB\/s\)/);
  assert.equal(slowBundleReason({ start: 0, sent: 1200, size: 1200, ms: 400, finished: true }), undefined, 'a tiny bundle in 0.4 s is not judged');
  assert.match(slowBundleReason({ start: 0, sent: 500_000, size: 500_000, ms: 8_000, finished: true })!, /went out in 8\.0 s \(61 KB\/s\)/);
  assert.equal(slowBundleReason({ start: 0, sent: 18_000_000, size: 18_000_000, ms: 7_400, finished: true }), undefined);
  assert.match(slowRunningReason(3_000_000, 60_000, 18_000_000)!, /still going after 60 s, 3000000 of 18000000 bytes \(49 KB\/s\)/);
  assert.equal(slowRunningReason(18_000_000, 60_000, 18_000_000), undefined);
});

test('the ping summary names each pong path, the timeouts and the closing line', () => {
  const out = ['pong from beast (100.101.2.3) via DERP(ord) in 54ms', 'pong from beast (100.101.2.3) via DERP(ord) in 61ms', 'timeout waiting for ping reply', 'direct connection not established'].join('\n');
  assert.equal(pingSummary({ code: 1, stdout: out }), '2 pongs: DERP(ord) 54ms, DERP(ord) 61ms; 1 timeout; "direct connection not established"; exit 1');
  assert.equal(pingSummary({ code: 0, stdout: 'pong from beast (100.101.2.3) via 98.43.75.76:41641 in 23ms\n' }), '1 pong: 98.43.75.76:41641 23ms; exit 0');
  assert.equal(pingSummary(undefined), 'did not run');
});

test('the line says direct or relayed, and the handshake age', () => {
  const p = findPeer(status, { machineId: 'beast' })!;
  const line = pathLine('beast', 'the update bundle went out in 8.0 s (61 KB/s)', p, '', '1 pong: DERP(ord) 54ms; exit 1', Date.parse('2026-11-26T10:00:30Z'));
  assert.equal(
    line,
    `machine beast: tailscale path, as the update bundle went out in 8.0 s (61 KB/s): peer beast ${SHORT} 100.101.2.3, online, active, relayed by DERP ord (CurAddr -, Relay ord), LastHandshake 2026-11-26T10:00:00Z (30 s ago), RxBytes 1234, TxBytes 5678; ping 1 pong: DERP(ord) 54ms; exit 1`,
  );
  assert.doesNotMatch(line, new RegExp(KEY_HEX));
  const m5 = findPeer(status, { machineId: 'm5' })!;
  assert.match(pathLine('m5', 'x', m5, '', 'y'), /direct 203\.0\.113\.5:41641 .*LastHandshake never/);
});

test('the probe runs status then ping on the peer IP, once per machine per cooldown, and logs one line', async () => {
  const calls: string[][] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'status') return { code: 0, stdout: status };
    return { code: 0, stdout: 'pong from beast (100.101.2.3) via DERP(ord) in 50ms\n' };
  };
  const logged: string[] = [];
  let now = Date.parse('2026-11-26T10:00:10Z');
  const probe = new TailscalePathProbe(run, (l) => logged.push(l), () => now);
  const line = await probe.probe('beast', 'the update bundle was cut', undefined);
  assert.deepEqual(calls, [['tailscale', 'status', '--json'], ['tailscale', 'ping', '-c', '5', '100.101.2.3']]);
  assert.deepEqual(logged, [line]);
  assert.match(line!, /peer beast .* relayed by DERP ord .*ping 1 pong: DERP\(ord\) 50ms; exit 0$/);
  assert.equal(probe.probe('beast', 'again'), undefined, 'within the cooldown');
  now += PROBE_COOLDOWN_MS;
  assert.ok(probe.probe('beast', 'later'));
});

test('a refused status still logs a line, with the error and the ping of the address the bundle came from', async () => {
  const run: Run = async (_c, args) => (args[0] === 'status' ? { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled\nAccess denied' } : { code: 0, stdout: 'pong from x (100.64.1.1) via DERP(sea) in 9ms' });
  const logged: string[] = [];
  await new TailscalePathProbe(run, (l) => logged.push(l)).probe('m3', 'the update bundle was cut', '100.64.1.1');
  assert.deepEqual(logged, ['machine m3: tailscale path, as the update bundle was cut: tailscale status failed (exit 1: Access denied); ping 1 pong: DERP(sea) 9ms; exit 0']);
});
