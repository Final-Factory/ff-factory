import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDefaults } from './config.ts';
import { machineRunEnv, type MachineRef } from './secrets.ts';
import { PoolHeldError, setVaultContext } from './vault.ts';
import { fakeToken, useFakeVault } from './testVault.ts';

// The account each agent gets on a machine (w1078): every machine's runs take a vault token from the pool of the person the
// work is for. w755's useHostClaudeEnv (the host token or the Mac's own login, per machine) is gone, and an old config file
// that still sets it, or claudeEnv, userClaudeEnv or claudeAccounts.workers, changes nothing.

const MACHINES: [string, MachineRef][] = [['m3', 'm3'], ['m5', { id: 'm5' }], ['lothdesktop', 'lothdesktop'], ['beast (ssh)', { id: 'beast' }], ['the portal host', { id: 'fff-portal', local: true }]];
const OLD = {
  claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken('old'), CLAUDE_CONFIG_DIR: '/cfg' },
  userClaudeEnv: { lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken('lothsahn-old') } },
  claudeAccounts: { workers: 'login' },
};
const who = (id?: string) => (id ? { userId: id, displayName: id } : undefined);

test('machine accounts: every machine gets the vault token of the person the work is for, whatever an old config says', (t) => {
  t.after(() => setVaultContext(undefined));
  useFakeVault();
  for (const machines of [undefined, { useHostClaudeEnv: false }, { useHostClaudeEnv: { '*': false, m3: true } }, { claudeFromVault: false }]) {
    const cfg = withDefaults({ ...OLD, machines });
    for (const [name, ref] of MACHINES) {
      for (const person of ['lothsahn', 'ben']) {
        const r = machineRunEnv(cfg, ref, { role: 'workers', requestedBy: who(person) });
        assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, fakeToken(person), `${name} for ${person}`);
        assert.equal(r.login, true, `${name}: the daemon's own credentials are dropped`);
        assert.equal(r.person, person, name);
        assert.match(r.account, /^vault token vault-\w+-1 …xxxx \(\w+'s pool/, name);
        assert.equal(JSON.stringify(r).includes(OLD.claudeEnv.CLAUDE_CODE_OAUTH_TOKEN), false, `${name}: the old config's token is never used`);
        assert.equal(r.env.CLAUDE_CONFIG_DIR, undefined, `${name}: nothing of claudeEnv is sent`);
      }
    }
  }
});

test('machine accounts: a machine with no usable vault token for its person does not start the run, and is never given another account', (t) => {
  t.after(() => setVaultContext(undefined));
  const cfg = withDefaults(OLD);
  useFakeVault({ vault: { forRun: () => ({ env: {}, problems: [], poolSize: 0 }) } as never });
  for (const [name, ref] of MACHINES) {
    assert.throws(
      () => machineRunEnv(cfg, ref, { role: 'standing', requestedBy: who('lothsahn') }),
      (e: unknown) => e instanceof PoolHeldError && /lothsahn has no Claude token in the vault/.test(e.message) && /never runs on another credential/.test(e.message),
      name,
    );
  }
  setVaultContext(undefined);
  for (const [name, ref] of MACHINES) assert.throws(() => machineRunEnv(cfg, ref, { role: 'workers', requestedBy: who('ben') }), PoolHeldError, `${name}: no vault at all`);
});
