// w1126: a usage gate names its pool however the dispatcher wrote it, and says when the pool's hold lifts on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolForRef, type GatePoolToken } from './usageGate.ts';

const HELD_UNTIL = '2026-10-12T12:50:00.000Z';
const held = (name: string, last4: string): GatePoolToken => ({ name, last4, priority: false, view: { state: 'held', until: HELD_UNTIL } });
const ok = (name: string, last4: string, priority = true): GatePoolToken => ({ name, last4, priority, view: { state: 'ok' } });

test('w1126: a usage gate on "vault-lothsahn-1" (the dispatcher\'s words on w1116..w1124) names lothsahn\'s pool, as do its full label, its person and "<person>\'s pool"', () => {
  const pools: [string, GatePoolToken[]][] = [
    ['lothsahn', [held('vault-lothsahn-1', 'EAAA')]],
    ['ben', [ok('vault-ben-1', 'nQAA'), ok('vault-ben-2', 'dAAA', false)]],
  ];
  // What the dispatcher gave on 2026-10-12 12:35Z: the bare vault name. The gate read "unknown" and never cleared.
  for (const ref of ['vault-lothsahn-1', 'vault-lothsahn-1 …EAAA', 'vault-lothsahn-1 ...EAAA', ' Vault-Lothsahn-1 …eaaa ', 'lothsahn', "lothsahn's pool", "lothsahn's Claude pool", "Lothsahn's Claude token pool"]) {
    const p = poolForRef(ref, pools);
    assert.equal(p?.person, 'lothsahn', `"${ref}" names lothsahn's pool`);
    assert.equal(p?.ref, 'vault-lothsahn-1 …EAAA', `"${ref}" is kept as the token's label`);
    assert.equal(p?.serves, false);
    assert.equal(p?.until, HELD_UNTIL, 'the hold lifts on its own at the first reset');
  }
  const ben = poolForRef('vault-ben-2', pools)!;
  assert.deepEqual([ben.person, ben.ref, ben.serves, ben.until], ['ben', 'vault-ben-2 …dAAA', true, undefined], "a token's pool serves when any of its tokens would take a worker");
  assert.equal(poolForRef('ben', pools)?.ref, 'vault-ben-1 …nQAA', "a person names their pool's first token");
  for (const ref of ['vault-lothsahn', 'vault-lothsahn-2', 'sam', 'lothsahn@example.com', '']) assert.equal(poolForRef(ref, pools), undefined, `"${ref}" names no pool`);
});
