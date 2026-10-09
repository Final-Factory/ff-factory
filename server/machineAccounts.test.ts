import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDefaults } from './config.ts';
import { accountSource, hostClaudeEnvFor, machineRunEnv, machineUsesLogin, usesHostClaudeEnv, type MachineRef } from './secrets.ts';

// The account each agent gets on a machine (w755): retiring claudeAccounts.workers must not move any of them. The rows for
// ordinary machines (a Mac, a PC, BEAST over ssh) are the same on the code before w755 (run against origin/main 702d299). The
// portal's own host as a machine (`local`) is the one that changed: see the last test.

const TOKEN = 'sk-ant-oat01-' + 'x'.repeat(40) + 'WXYZ';
const LOTH_TOKEN = 'sk-ant-oat01-' + 'y'.repeat(40) + 'LLLL';
const claudeEnv = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, CLAUDE_CONFIG_DIR: '/cfg' };
const MACHINES: [string, MachineRef][] = [['m3', 'm3'], ['m5', { id: 'm5' }], ['lothdesktop', 'lothdesktop'], ['beast (ssh)', { id: 'beast' }]];
const LOCAL: MachineRef = { id: 'fff-portal', local: true };

/** What a machine's agent gets from a config file's `machines.useHostClaudeEnv`: the account label, and whether the host token is sent. */
function row(machines: unknown, ref: MachineRef, extra: Record<string, unknown> = {}) {
  const cfg = withDefaults({ claudeEnv, machines: { useHostClaudeEnv: machines }, ...extra });
  const env = hostClaudeEnvFor(cfg, ref);
  return { uses: usesHostClaudeEnv(cfg, ref), login: machineUsesLogin(cfg, ref), token: env.CLAUDE_CODE_OAUTH_TOKEN, account: accountSource(cfg, ref), dir: env.CLAUDE_CONFIG_DIR };
}

test('machine accounts: no machines setting means the host token everywhere', () => {
  for (const [name, ref] of MACHINES) {
    const r = row(undefined, ref);
    assert.deepEqual([r.uses, r.login, r.token, r.account], [true, false, TOKEN, 'host token …WXYZ'], name);
  }
});

test('machine accounts: machines.useHostClaudeEnv false, or one entry per machine, picks the Mac\'s own login for those named', () => {
  for (const [name, ref] of MACHINES) {
    const id = typeof ref === 'string' ? ref : ref.id;
    const off = row(false, ref);
    assert.deepEqual([off.uses, off.login, off.token], [false, true, undefined], `${name}: false for all`);
    assert.equal(off.account, "Mac login (the Mac's own Claude Code login)", name);
    assert.equal(off.dir, undefined, `${name}: a Mac on its own login is sent nothing`);
    const named = row({ [id]: false, '*': true }, ref);
    assert.deepEqual([named.uses, named.token], [false, undefined], `${name}: named false`);
    const others = row({ other: false }, ref);
    assert.deepEqual([others.uses, others.token], [true, TOKEN], `${name}: not named: the default`);
    const star = row({ '*': false, [id]: true }, ref);
    assert.deepEqual([star.uses, star.token], [true, TOKEN], `${name}: named true beats "*" false`);
    assert.deepEqual([row({ '*': false }, ref).uses], [false], `${name}: "*" false`);
  }
});

test('machine accounts: the run env on a machine carries the host token, the Mac login, or a person\'s own token as before', () => {
  const base = { claudeEnv, userClaudeEnv: { lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: LOTH_TOKEN } } };
  const env = (machines: unknown, ref: MachineRef, who?: string) => {
    const cfg = withDefaults({ ...base, machines: { useHostClaudeEnv: machines } });
    return machineRunEnv(cfg, ref, { role: 'workers', requestedBy: who ? { userId: who, displayName: who } : undefined }, undefined);
  };
  for (const [name, ref] of MACHINES) {
    assert.equal(env(undefined, ref).env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN, `${name}: host token`);
    assert.equal(env({ '*': false }, ref).env.CLAUDE_CODE_OAUTH_TOKEN, undefined, `${name}: own login`);
    assert.equal(env({ '*': false }, ref).login, true, name);
    assert.equal(env(undefined, ref, 'lothsahn').env.CLAUDE_CODE_OAUTH_TOKEN, LOTH_TOKEN, `${name}: a person's own token wins`);
    assert.equal(env({ '*': false }, ref, 'lothsahn').env.CLAUDE_CODE_OAUTH_TOKEN, LOTH_TOKEN, `${name}: even on the Mac's login`);
  }
});

test('machine accounts (w755): a retired claudeAccounts.workers in an old config file changes none of it, for any machine but the portal\'s own host', () => {
  for (const workers of ['token', 'login', 'tokenfile']) {
    for (const [name, ref] of MACHINES) {
      for (const setting of [undefined, false, true, { '*': false }, { m3: false }]) {
        assert.deepEqual(row(setting, ref, { claudeAccounts: { workers } }), row(setting, ref), `${name}: workers ${workers}, useHostClaudeEnv ${JSON.stringify(setting)}`);
      }
    }
  }
});

test('machine accounts (w755): the portal\'s own host as a machine follows machines.useHostClaudeEnv like any other', () => {
  // Before w755 it ignored a boolean or "*" setting and followed claudeAccounts.workers ("login": its own stored login) unless an
  // entry named its id. The live portal is a Linux VM and cannot have one (a local machine is Windows-only, server/machines.ts);
  // fff-migrate writes the entry for BEAST. Now: the entry naming it, else the boolean or "*", else the host token.
  assert.deepEqual(row(undefined, LOCAL, { claudeAccounts: { workers: 'login' } }), row(undefined, LOCAL), 'the retired key is ignored');
  assert.equal(row(undefined, LOCAL).token, TOKEN);
  assert.equal(row({ 'fff-portal': true, '*': false }, LOCAL).token, TOKEN);
  const own = row({ 'fff-portal': false }, LOCAL);
  assert.deepEqual([own.uses, own.login, own.token, own.dir], [false, true, undefined, '/cfg'], 'its own stored login, with the rest of claudeEnv kept');
  assert.match(own.account, /login \(this host's stored Claude login/);
  assert.equal(row(false, LOCAL).token, undefined, 'false for every machine: this one too');
  assert.equal(row({ '*': false }, LOCAL).token, undefined);
});
