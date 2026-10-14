import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OWNER_ONLY_KEYS, SETTABLE_KEYS, normalizeSetting, setAppConfig, type SettableKey } from './appConfig.ts';
import { NIGHTLY_SENTRY, Vault, newKeyText, personForWork, setVaultContext, tokenPersonForWork, unattributedPerson } from './vault.ts';
import { checkAccountConfig, type Config } from './config.ts';
import { useFakeVault } from './testVault.ts';

/** set_app_config vault.unattributed.intake / .ffbox / .nightly (w1289, docs/vault.md section 10). */

const KEYS = ['vault.unattributed.intake', 'vault.unattributed.ffbox', 'vault.unattributed.nightly'] as const;
const USERS = ['ben', 'lothsahn', 'carol'];
const claudeTok = (c: string) => `sk-ant-oat01-${c.repeat(44)}`;

function setup(t: { after: (fn: () => void) => void }, config: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unattr-'));
  t.after(() => {
    setVaultContext(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 8790, ...config }, null, 2));
  const cfg = { vault: config.vault } as unknown as Config;
  return { dir, file, cfg };
}

/** A vault context where only `owners` have an enabled Claude token (hasClaudeFor is the one question asked). */
const vaultWithPoolsFor = (owners: string[]) => useFakeVault({ vault: { hasClaudeFor: (p: string) => owners.some((o) => o.toLowerCase() === p.toLowerCase()) } as never });

const src = (kind: string) => ({ kind, untrusted: true }) as never;
const saved = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('vault.unattributed.*: settable, and the owner\'s only like claudeAccounts.dispatcher', () => {
  for (const k of KEYS) {
    assert.ok(SETTABLE_KEYS.includes(k), k);
    assert.ok(OWNER_ONLY_KEYS.has(k), `${k} owner-only`);
  }
  assert.ok(OWNER_ONLY_KEYS.has('claudeAccounts.dispatcher'));
  assert.equal(SETTABLE_KEYS.includes('vault.unattributed' as SettableKey), false, 'only the three kinds, not the whole block');
});

test('vault.unattributed.*: a login with a Claude pool is accepted, in the login\'s own spelling', (t) => {
  const { file, cfg } = setup(t);
  vaultWithPoolsFor(['ben', 'lothsahn']);
  for (const k of KEYS) assert.equal(normalizeSetting(k, '  BEN ', cfg, USERS), 'ben', k);
  assert.deepEqual(setAppConfig(file, cfg, 'vault.unattributed.nightly', 'Ben', { users: USERS }), { before: undefined, after: 'ben' });
});

test('vault.unattributed.*: an unknown user id is refused and nothing is written', (t) => {
  const { file, cfg } = setup(t);
  vaultWithPoolsFor(['ben', 'lothsahn', 'mallory']);
  const before = fs.readFileSync(file, 'utf8');
  for (const k of KEYS) {
    assert.throws(() => setAppConfig(file, cfg, k, 'mallory', { users: USERS }), /no login "mallory"; the logins are ben, lothsahn, carol/, k);
    assert.throws(() => setAppConfig(file, cfg, k, 'ben', { users: [] }), /no login "ben"; the logins are \(none\)/, 'no logins known: refused');
  }
  for (const bad of ['', '   ', 42, true, ['ben'], { id: 'ben' }]) {
    assert.throws(() => setAppConfig(file, cfg, 'vault.unattributed.nightly', bad, { users: USERS }), /is a user id/, JSON.stringify(bad));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file is left alone');
  assert.equal(cfg.vault, undefined, 'and so is the running config');
});

test('vault.unattributed.*: a person with no Claude token in the vault is refused and nothing is written', (t) => {
  const { file, cfg } = setup(t);
  vaultWithPoolsFor(['lothsahn']);
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => setAppConfig(file, cfg, 'vault.unattributed.nightly', 'carol', { users: USERS }), /carol has no enabled Claude token in the vault that its key opens/);
  assert.throws(() => setAppConfig(file, cfg, 'vault.unattributed.intake', 'ben', { users: USERS }), /ben has no enabled Claude token/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(cfg.vault, undefined);
  // No vault loaded in this process: the pool cannot be checked, so nothing is set.
  setVaultContext(undefined);
  assert.throws(() => setAppConfig(file, cfg, 'vault.unattributed.nightly', 'lothsahn', { users: USERS }), /vault is not loaded/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('Vault.hasClaudeFor: an enabled Claude entry the person owns that the key opens; not a disabled, a GitHub or another person\'s', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unattr-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'vault.key');
  fs.writeFileSync(keyFile, newKeyText(), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const v = new Vault({ file: path.join(dir, 'vault.json'), key: () => ({ file: keyFile }) });
  v.add({ name: 'vault-ben-1', kind: 'claude', value: claudeTok('b'), owner: 'ben', share: 'owner' });
  v.add({ name: 'vault-carol-1', kind: 'claude', value: claudeTok('c'), owner: 'carol', share: 'owner' });
  v.add({ name: 'vault-dave-github', kind: 'github', value: ['ghp', '_', 'd'.repeat(36)].join(''), owner: 'dave', share: 'owner' });
  v.update('vault-carol-1', { disabled: true });
  assert.equal(v.hasClaudeFor('ben'), true);
  assert.equal(v.hasClaudeFor('BEN'), true, 'logins compare without case');
  assert.equal(v.hasClaudeFor('carol'), false, 'disabled');
  assert.equal(v.hasClaudeFor('dave'), false, 'a GitHub token is not a Claude pool');
  assert.equal(v.hasClaudeFor('nobody'), false);
  // A key that does not open the entries (the vault key is gone): no pool.
  const lost = new Vault({ file: path.join(dir, 'vault.json'), key: () => ({ file: path.join(dir, 'missing.key') }) });
  assert.equal(lost.hasClaudeFor('ben'), false);
});

test('vault.unattributed.*: written to config.json and applied live; null goes back to the default and leaves no empty block', (t) => {
  const { file, cfg } = setup(t, { vault: { keyFile: '/etc/fff/vault.key' } });
  vaultWithPoolsFor(['ben', 'lothsahn']);
  const nightlyRun = { unattributed: true, source: src('nightly-run') };
  const nightlySentry = { delegation: { id: 'd', agentId: NIGHTLY_SENTRY, agentName: 'Nightly sentry', auto: true } };
  const intake = { unattributed: true, source: src('discord-bug') };
  const ffbox = { unattributed: true, source: src('ffbox-diagnosis') };
  const requestedBy = { userId: 'lothsahn', displayName: 'Lothsahn' };
  const personFor = (w: object) => personForWork(cfg, { ...w, requestedBy } as never);

  // Before: every kind on the default.
  assert.equal(unattributedPerson(cfg, 'nightly'), 'lothsahn');
  assert.equal(personFor(nightlyRun), 'lothsahn');

  // The same config object the intake, the standing agents and the token picks hold: the new value is read at the next run.
  assert.deepEqual(setAppConfig(file, cfg, 'vault.unattributed.nightly', 'ben', { users: USERS }), { before: undefined, after: 'ben' });
  assert.deepEqual(cfg.vault?.unattributed, { nightly: 'ben' });
  assert.equal(cfg.vault?.keyFile, '/etc/fff/vault.key', 'the rest of vault is kept');
  assert.equal(unattributedPerson(cfg, 'nightly'), 'ben');
  assert.equal(tokenPersonForWork(cfg, nightlyRun as never), 'ben', 'the nightly run and review jobs');
  assert.equal(tokenPersonForWork(cfg, nightlySentry as never), 'ben', "the sentry's delegations");
  assert.equal(personFor(nightlyRun), 'ben', 'the person a worker session runs for follows it, whoever filed it');
  assert.equal(tokenPersonForWork(cfg, intake as never), 'lothsahn', 'the other kinds stay on the default');
  assert.equal(tokenPersonForWork(cfg, ffbox as never), 'lothsahn');
  assert.equal(tokenPersonForWork(cfg, { ...nightlyRun, runsFor: { userId: 'lothsahn' } } as never), 'lothsahn', 'a person who acted on the request still wins');
  assert.deepEqual(saved(file).vault, { keyFile: '/etc/fff/vault.key', unattributed: { nightly: 'ben' } });
  checkAccountConfig({ vault: saved(file).vault, claudeAccounts: {} } as never); // the portal reads this file at its next start
  assert.equal(saved(file).port, 8790);
  assert.ok(fs.existsSync(file + '.prev'));

  // Another kind: the first stays.
  setAppConfig(file, cfg, 'vault.unattributed.ffbox', 'ben', { users: USERS });
  assert.deepEqual(cfg.vault?.unattributed, { nightly: 'ben', ffbox: 'ben' });
  assert.equal(tokenPersonForWork(cfg, ffbox as never), 'ben');

  // null: back to the default, key by key; the last one takes the empty block out of the file and the running config.
  assert.deepEqual(setAppConfig(file, cfg, 'vault.unattributed.nightly', null), { before: 'ben', after: undefined });
  assert.equal(unattributedPerson(cfg, 'nightly'), 'lothsahn');
  assert.deepEqual(cfg.vault?.unattributed, { ffbox: 'ben' });
  assert.deepEqual(setAppConfig(file, cfg, 'vault.unattributed.ffbox', null), { before: 'ben', after: undefined });
  assert.equal(cfg.vault?.unattributed, undefined);
  assert.deepEqual(saved(file).vault, { keyFile: '/etc/fff/vault.key' });
  assert.equal(unattributedPerson(cfg, 'ffbox'), 'lothsahn');
  // null needs no vault and no logins: clearing a key is always allowed.
  setVaultContext(undefined);
  assert.deepEqual(setAppConfig(file, cfg, 'vault.unattributed.intake', null), { before: undefined, after: undefined });
});
