// w2648 (lothsahn, 2026-10-31): w2631, the 3-leg determinism pair run for w2622, sat about 3 hours. Its brief said "Direct
// IP, no Steam, no menus", the menu reader took "menus" as menu clicks and kept it off every computer with a locked screen
// (m5, m3), nothing could re-mark it, and the dispatcher then asked lothsahn a card whose answers differed only in legs
// and waiting ("re-file 2 legs, starts now", "3 legs, wait for lothdesktop", "leave queued").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affirmedMention } from '../shared/mentions.ts';
import { MENUS_NONE, MENUS_READ, mentionsMenus, pairDrivesMenus } from '../shared/desktop.ts';
import { mentionsSteam } from '../shared/steam.ts';
import { placementForkProblem, placementOnlyAsk } from '../shared/machineAsk.ts';
import { remarkPair } from './orchestrators.ts';

// w2631's brief as filed (read_work w2631, 2026-10-31 08:39), the lines that name a menu, a lobby or a click, or none.
const W2631 = [
  'How it runs: built players launched from the slot pool with the -ffAutomation* contract, as run_build_multiplayer_audit.sh / run_logistics_audit.sh do.',
  'Put `-ffFeatures=ship-dispatch-v2` on EVERY peer; the host\'s set wins on join anyway. Direct IP, no Steam, no menus. Read the determinism-audit skill\'s gotchas.md §linux-client-leg first (PostConnectDelayMs, no early AutoQuit), and run reach.py to the host before joining.',
  'Legs: 3 computers (host + 2 clients). A Mac may host but never be a client. If a third computer is not free, run the joiner as a second client process on the host\'s machine, and say so.',
].join('\n');

test('w2648: a negated mention of a menu, a lobby or a click is no menu click; an affirmed one still is', () => {
  for (const none of ['no menus', 'Direct IP, no Steam, no menus.', "doesn't click any menu", 'does not click any menu', 'It runs without clicking.', 'no lobby, direct IP', 'never opens a dialog', 'Headless; no title or lobby menus.'])
    assert.equal(mentionsMenus(none), false, none);
  for (const clicks of ['clicks through the lobby menu', 'Click Load in the title menu', 'host a lobby', 'No Steam, but it clicks Host in the title menu', 'no desync expected; the host clicks Join'])
    assert.equal(mentionsMenus(clicks), true, clicks);
  assert.equal(mentionsMenus('Pair run for w2622: ship-dispatch-v2 3-peer determinism check', W2631), false, "w2631's brief clicks no menu");
  assert.equal(mentionsSteam(W2631), false, "w2631's brief needs no Steam");
  assert.equal(mentionsSteam('no Steam lobby: direct IP'), false);
  assert.equal(mentionsSteam('host a Steam lobby and join it'), true);
  assert.equal(affirmedMention('not the lobby, then click the menu', /\bmenus?\b/i), true, 'a clause ends at "then"');
});

test('w2648: remarkPair sets legs and menus on a pair run; "none" clears a mark read from its words and keeps them unread', () => {
  const read = { legs: 3, for: 'w2622', menus: MENUS_READ };
  const r = remarkPair(read, { legs: 2, menus: 'none' });
  assert.equal(r.changed, true);
  assert.equal(pairDrivesMenus(r.pair), false);
  assert.deepEqual(r.pair, { legs: 2, for: 'w2622', noMenus: MENUS_NONE });
  assert.match(r.was, /^a pair run of 3 legs, .*only on computers whose screen is unlocked/);
  const back = remarkPair(r.pair, { menus: 'the title menu' });
  assert.deepEqual(back.pair, { legs: 2, for: 'w2622', menus: 'the title menu' });
  assert.equal(remarkPair(back.pair, { legs: 2 }).changed, false);
  // A Steam pair clicks its lobby whatever menus says.
  const steam = { legs: 2, steam: 'a Steam lobby join' };
  assert.deepEqual(remarkPair(steam, { menus: 'none' }).pair, steam);
});

// The card the dispatcher sent lothsahn at 08:40 (read_work w2631: "[needs you] sent to lothsahn's orchestrator").
const CARD = {
  question: 'w2631 (3-peer ship-dispatch-v2 determinism check) is queued: it needs 3 computers at once and only beast fits. How should it run?',
  options: [
    { label: 'Re-file 2 legs, starts now', description: 'm5 hosts, beast runs client 1 and the joiner as a second process.', recommended: true },
    { label: '3 legs, wait for lothdesktop', description: 'It starts when lothsahn stops playing on lothdesktop.' },
    { label: 'Leave queued', description: 'It waits until three computers are free.' },
  ],
};
const IDS = ['beast', 'lothdesktop', 'biscuit', 'lothlaptop', 'm3', 'm5'];

test("w2648: a card whose answers differ only in machines, legs or waiting is refused, and names the answer that starts now", () => {
  assert.equal(placementOnlyAsk(CARD, IDS), true);
  const why = placementForkProblem([CARD], IDS, 'dispatcher') ?? '';
  assert.match(why, /^Nothing was recorded \(w2648, after w2147; lothsahn, 2026-10-25: "Use and schedule resources/);
  assert.match(why, /Take the one that starts on what is there now \("Re-file 2 legs, starts now"\)/);
  assert.match(why, /decide_work pair_legs and pair_menus/);
  assert.match(placementForkProblem([CARD], IDS, 'worker') ?? '', /request_pair, asked again with legs or menus/);
  for (const q of [
    { question: 'Run it on m5 or on beast?', options: [{ label: 'On m5' }, { label: 'On beast', recommended: true }] },
    { question: 'How many legs?', options: [{ label: '2 legs' }, { label: '3 legs' }] },
    { question: 'Now or later?', options: [{ label: 'Start it now in a free sandbox' }, { label: 'Wait for a free sandbox' }] },
  ])
    assert.equal(placementOnlyAsk(q, IDS), true, q.question);
});

test('w2648: a fork a person owns still goes through: design, money, merges, logins, approvals', () => {
  for (const q of [
    { question: 'Which look should the button have?', options: [{ label: 'The round one' }, { label: 'The square one' }] },
    { question: 'Is the circuit button look OK?', options: [{ label: 'Yes, merge it', recommended: true }, { label: 'No, change it first' }] },
    { question: 'Run the cloud A/B now?', options: [{ label: 'Start now, it costs $40' }, { label: 'Wait for the bench on beast' }] },
    { question: 'm5 is locked: can you log in on it?', options: [{ label: 'I will log in on m5 now' }, { label: 'Wait for m5' }] },
    { question: 'Single-player or co-op?', options: [{ label: 'Single-player on beast' }, { label: 'Co-op on beast and m5' }] },
    { question: 'Which one?', options: [{ label: 'The first', recommended: true }, { label: 'The second' }] },
    // w1597's fixture: verbs that go with placement, but no machine, leg or wait between the answers.
    { question: 'Should the vision speed-up go in?', options: [{ label: 'Put it in', recommended: true }, { label: 'Leave it out' }] },
    { question: 'The tour failed once. What now?', options: [{ label: 'Run it again' }, { label: 'Leave it' }] },
  ])
    assert.equal(placementOnlyAsk(q, IDS), false, q.question);
  assert.equal(placementForkProblem([{ question: 'Which look?', options: [{ label: 'Round' }, { label: 'Square' }] }], IDS, 'dispatcher'), undefined);
});
