import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrityArgv, integrityOf, measureAgentIntegrity, writesMedium } from './agentIntegrity.ts';
import { FenceGate } from './fenceGate.ts';
import { fenceReportOf } from '../server/machines.ts';

// What 243c0a9d (w6002's leg on lothdesktop/slot5) and this request's own worker read on 2026-11-26.
const LOW = `GROUP INFORMATION
-----------------
Group Name                             Type             SID          Attributes
====================================== ================ ============ ==================================================
Everyone                               Well-known group S-1-1-0      Mandatory group, Enabled by default, Enabled group
Mandatory Label\\Low Mandatory Level    Label            S-1-16-4096
`;

test('w6003: the level is read from whoami /groups, never guessed', () => {
  assert.equal(integrityOf(LOW), 'low');
  assert.equal(integrityOf(LOW.replace('Low Mandatory', 'Medium Mandatory')), 'medium');
  assert.equal(integrityOf(LOW.replace('Low Mandatory', 'Medium Plus Mandatory')), 'medium');
  assert.equal(integrityOf(LOW.replace('Low Mandatory', 'High Mandatory')), 'high');
  assert.equal(integrityOf('whoami: extra operand /groups'), undefined, "Git Bash's coreutils whoami names no label");
  assert.equal(writesMedium('low'), false);
  assert.equal(writesMedium(undefined), false);
  assert.equal(writesMedium('medium'), true);
  assert.equal(writesMedium('high'), true);
});

test('w6003: measured by the route a sandbox agent takes: the agent Git bash when the Low fence is on, else from the daemon', async () => {
  const bash = 'V:\\ffw\\tools\\git\\bin\\bash.exe';
  const low = integrityArgv({ lowBash: bash, systemRoot: 'C:\\Windows' });
  assert.deepEqual(low, [bash, '-c', `MSYS2_ARG_CONV_EXCL='*' "C:/Windows/System32/whoami.exe" /groups`], 'MSYS2_ARG_CONV_EXCL keeps /groups an option (w5988)');
  assert.deepEqual(integrityArgv({ systemRoot: 'C:\\Windows' }), ['C:\\Windows\\System32\\whoami.exe', '/groups']);
  const ran: string[][] = [];
  const got = await measureAgentIntegrity(low, async (cmd, args) => (ran.push([cmd, ...args]), { code: 0, stdout: LOW, stderr: '' }));
  assert.deepEqual(got, { level: 'low' });
  assert.deepEqual(ran, [low]);
  assert.match(JSON.stringify(await measureAgentIntegrity(low, async () => ({ code: 127, stdout: '', stderr: 'not found' }))), /"why":"bash\.exe exit 127: no Mandatory Label line \(not found\)"/);
  assert.deepEqual(await measureAgentIntegrity(low, async () => { throw new Error('spawn EACCES'); }), { why: 'spawn EACCES' });
});

test('w6003: the gate sends the measured level with its state, keeps it when the state changes, and the portal reads it', () => {
  const sent: unknown[] = [];
  const g = new FenceGate({ wanted: true, kind: 'low', changed: (r) => sent.push(r), now: () => new Date('2026-11-26T10:00:00Z') });
  g.measured({ why: 'no agent Git bash' });
  assert.equal(g.state.agentIntegrityWhy, 'no agent Git bash');
  g.on();
  assert.equal(g.state.agentIntegrityWhy, 'no agent Git bash', 'a later state keeps it');
  g.measured({ level: 'low' });
  const r = g.state;
  assert.equal(r.state, 'on');
  assert.equal(r.agentIntegrity, 'low');
  assert.equal(r.agentIntegrityWhy, undefined, 'a level replaces the old why');
  assert.equal(r.agentIntegrityAt, '2026-11-26T10:00:00.000Z');
  assert.equal(sent.length, 3);
  assert.deepEqual(fenceReportOf(sent[2]), r);
  assert.equal(fenceReportOf({ state: 'on', agentIntegrity: 'medium-ish' })!.agentIntegrity, undefined, 'an unknown word is no level');
});
