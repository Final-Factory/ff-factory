// The portal's half of its ssh to the machines (server/machineSsh.ts, w568): what a worker installer registers, the
// known_hosts2 the portal pins it in, and the key line it hands the installer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KNOWN_HOSTS_MARK, authorizedKeyLine, knownHostsText, parseSshRegistration, portalPublicKey, tailnetAddress, writeKnownHosts } from './machineSsh.ts';

// The m3's real ed25519 host key (deploy/vm/guest/machines.ssh, measured w537) and an ecdsa one.
const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJPzhFYZX4GtbGkBP2Fl8RqwkZaXjQ9fUWN9P+p+/OX3';
const EC = 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFa=';

test('machineSsh: a registration is the ssh user, the name the portal reaches the machine by and its host keys, checked', () => {
  const at = new Date('2026-10-06T21:00:00Z');
  assert.deepEqual(parseSshRegistration({ user: 'benryding', host: 'M3.', hostKeys: [`${ED} root@m3`, EC, ED] }, at), { user: 'benryding', host: 'm3', hostKeys: [ED, EC], at: at.toISOString() });
  assert.match((parseSshRegistration({ user: 'ben ryding', host: 'm3', hostKeys: [ED] }) as { error: string }).error, /^user:/);
  assert.match((parseSshRegistration({ user: 'b', host: 'm3;rm -rf /', hostKeys: [ED] }) as { error: string }).error, /^host:/);
  assert.match((parseSshRegistration({ user: 'b', host: 'm3', hostKeys: [] }) as { error: string }).error, /^hostKeys:/);
  assert.match((parseSshRegistration({ user: 'b', host: 'm3', hostKeys: ['ssh-dss AAAAB3NzaC1kc3MAAACBAP'] }) as { error: string }).error, /not an ssh host key/);
  // Only "<type> <base64>" of each key is kept: a newline cannot smuggle a second known_hosts line in.
  assert.deepEqual((parseSshRegistration({ user: 'b', host: 'm3', hostKeys: [`${ED}\nevil.example ${EC}`] }, at) as { hostKeys: string[] }).hostKeys, [ED]);
  assert.match((parseSshRegistration(null) as { error: string }).error, /^user:/);
});

test('machineSsh: known_hosts2 pins each registered machine\'s host keys under its name, the portal\'s header first', () => {
  const machines = [
    { id: 'm5' },
    { id: 'm3', ssh: { user: 'benryding', host: 'm3', hostKeys: [ED, EC], at: '' } },
  ];
  const text = knownHostsText(machines);
  assert.ok(text.startsWith(KNOWN_HOSTS_MARK), text);
  assert.ok(text.includes(`\nm3 ${ED} m3\nm3 ${EC} m3\n`), text);
  assert.equal(knownHostsText([{ id: 'm5' }]), '', 'nothing registered: no file');
});

test('machineSsh: the portal writes its own known_hosts2, 0600, rewrites it on a change, removes it when no machine is left, and never touches one that is not its own', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-ssh-'));
  try {
    const file = path.join(home, '.ssh', 'known_hosts2');
    const m3 = { id: 'm3', ssh: { user: 'benryding', host: 'm3', hostKeys: [ED], at: '' } };
    assert.equal(writeKnownHosts([{ id: 'm5' }], home), 'none');
    assert.equal(fs.existsSync(file), false);
    assert.equal(writeKnownHosts([m3], home), 'written');
    assert.ok(fs.readFileSync(file, 'utf8').includes(`m3 ${ED} m3`));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(writeKnownHosts([m3], home), 'unchanged');
    assert.equal(writeKnownHosts([{ id: 'm3' }], home), 'removed', 'its machine unenrolled: the pin goes');
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, `someone ${ED}\n`);
    assert.equal(writeKnownHosts([m3], home), 'not ours');
    assert.equal(fs.readFileSync(file, 'utf8'), `someone ${ED}\n`, 'a person\'s known_hosts2 stays as it is');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('machineSsh: the line a machine authorizes the portal\'s key with: only from the portal, nothing forwarded', () => {
  const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGgE0GjCLsOOdLNBCR5KKXguNoZCX0Mh7C3tZbQzCDQx fff-portal@fff-portal';
  assert.equal(authorizedKeyLine(pub, '100.124.172.97'), `from="100.124.172.97",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${pub}`);
  assert.equal(authorizedKeyLine(`${pub}\n`), `no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${pub}`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-ssh-'));
  try {
    assert.equal(portalPublicKey(home), undefined);
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), `${pub}\n`);
    assert.equal(portalPublicKey(home), pub);
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');
    assert.equal(portalPublicKey(home), undefined, 'never anything but a public key');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('machineSsh: the portal\'s own tailnet address comes from tailscale ip -4, and only a tailnet one', async () => {
  assert.equal(await tailnetAddress(async () => ({ code: 0, stdout: '100.124.172.97\n' })), '100.124.172.97');
  assert.equal(await tailnetAddress(async () => ({ code: 0, stdout: '10.0.0.5\n' })), undefined);
  assert.equal(await tailnetAddress(async () => ({ code: 1, stdout: '' })), undefined);
  assert.equal(await tailnetAddress(async () => Promise.reject(new Error('ENOENT'))), undefined);
});
