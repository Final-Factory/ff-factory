import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveLines, reserveWarnings } from './secrets.ts';
import { warningsForUser } from './tokenPool.ts';
import type { PlanUsage } from '../shared/types.ts';

/**
 * w1108, lothsahn: "Please only show the dispatcher message to the operator whose pool that token is in." The banner "The
 * dispatcher's Claude token buffer is in use." reached every page, Ben's too, while the dispatcher's token was in
 * Lothsahn's pool. The token's pool is its vault entry's owner (server/vault.ts pools). Fakes only.
 */

const NOW = Date.parse('2026-10-12T12:00:00Z');
const inBuffer: PlanUsage = { available: true, asOf: new Date(NOW).toISOString(), weekly: { label: 'Weekly', percent: 99, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() }, session: { label: 'Session (5 h)', percent: 10, resetsAt: new Date(NOW + 3_600_000).toISOString() }, models: [] };
const cfg = { claudeAccounts: { dispatcher: 'vault:vault-lothsahn-1' } } as never;
const vaultWith = (owner: string | undefined) => ({ vault: { claudeByName: (name: string) => ({ entry: { name, last4: 'dAAA', ...(owner ? { owner } : {}) }, token: `fake-dispatcher-token-${'x'.repeat(30)}` }) } }) as never;
const OWNERS = ['ben', 'lothsahn'];

test("the dispatcher's buffer banner goes to the person whose pool holds its token, not to the other owner (w1108)", () => {
  const lines = reserveLines(cfg, () => inBuffer, () => 1, NOW, vaultWith('Lothsahn'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].warning, 'inside the buffer with another run on it');
  const all = reserveWarnings(lines, OWNERS);
  assert.deepEqual(all, [{ id: `reserve:${lines[0].cred.key}`, kind: 'reserve', person: 'lothsahn', text: lines[0].warning }], 'its text is the one it had');
  assert.equal(warningsForUser(all, 'lothsahn', true)?.length, 1, "Lothsahn's pool: his pages show it");
  assert.equal(warningsForUser(all, 'ben', true), undefined, 'not the other owner');
  assert.equal(warningsForUser(all, 'sam', false), undefined, 'nor anyone else');
  assert.match(lines[0].line, /^dispatcher's vault token vault-lothsahn-1 …dAAA: weekly 99%/, 'the system_status line is unchanged');
});

test("a dispatcher's token in nobody's pool shows its banner to the owners, never to everyone (w1108)", () => {
  const all = reserveWarnings(reserveLines(cfg, () => inBuffer, () => 1, NOW, vaultWith(undefined)), OWNERS);
  assert.deepEqual(all.map((w) => w.person), OWNERS);
  for (const owner of OWNERS) assert.equal(warningsForUser(all, owner, true)?.length, 1, owner);
  assert.equal(warningsForUser(all, 'sam', false), undefined, 'a member does not see it');
});

test('outside the buffer, or with nobody else on the token, there is no banner at all (w1108)', () => {
  const calm: PlanUsage = { ...inBuffer, weekly: { ...inBuffer.weekly!, percent: 20 } };
  assert.deepEqual(reserveWarnings(reserveLines(cfg, () => calm, () => 1, NOW, vaultWith('lothsahn')), OWNERS), []);
  assert.deepEqual(reserveWarnings(reserveLines(cfg, () => inBuffer, () => 0, NOW, vaultWith('lothsahn')), OWNERS), []);
});
