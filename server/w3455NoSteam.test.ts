// w3455 (ben, 2026-11-07): two pair runs Ben cleared to run without Steam stayed Blocked on computers signed in to Steam.
// w3431's worker filed request_pair with steam "none: a direct (non-Steam) host and join ...", and only a bare "none" said
// none, so that text became the reason it needed Steam. w3392's brief said "Yes, no Steam", but the dispatcher's queue with
// pair_legs read its words, and FF Factory's own filing paragraph in it ("read from its words: a menu, a lobby, a click")
// named a lobby. Nothing could clear the mark on the existing request: decide_work pair_steam "none" now does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownWords } from '../shared/mentions.ts';
import { saysNone } from '../shared/desktop.ts';
import { mentionsSteam, saysNoSteam, STEAM_READ } from '../shared/steam.ts';
import { pairText } from '../shared/capacity.ts';
import { remarkPair, restatedSteam } from './orchestrators.ts';

// w3392's brief as filed (read_work w3392, 2026-11-07 12:59), the lines that name Steam, sign-ins or a lobby.
const W3392 = [
  'This run replaces w3370, which was filed with the wrong platform-account requirement. Ben, 2026-11-07: "Yes, no Steam: start it when two computers have room": the legs use a direct LAN or Tailscale host and join, with no platform sign-in on either machine.',
  '',
  "FF Factory filed this for worker 4696760c on w3360 (w1945, request_pair): a pair run of 2 legs, on any computers, any OS (a Mac only as the host, leg 1), only on computers whose screen is unlocked (it clicks the game's menus: read from its words: a menu, a lobby, a click; request_pair menus \"none\" says it clicks none). Its legs start together.",
].join('\n');
// w3431's (read_work w3431, 2026-11-07 18:07).
const W3431 = [
  "Leg 1 (host): host a new multiplayer game from this commit (editor or a development player built at this commit, the repo's usual paired multiplayer path, not Steam).",
  '',
  'FF Factory filed this for worker 96d0517c on w3315 (w1945, request_pair): a pair run of 2 legs, on any computers, any OS (a Mac only as the host, leg 1), only on computers signed in to Steam, a different Steam account on each leg, each screen unlocked (none: a direct (non-Steam) host and join as the repo\'s paired multiplayer runs do).',
].join('\n');

test('w3455: a pair run whose words say no Steam, or whose Steam words are only FF Factory\'s own filing text, needs no Steam', () => {
  assert.equal(mentionsSteam('Pair run for w3360: Escape menu open while riding', W3392), false, "w3392's brief needs no Steam");
  assert.equal(mentionsSteam('Pair run for w3315: planner kept across a rejoin', W3431), false, "w3431's brief needs no Steam");
  for (const none of ['a direct (non-Steam) host and join', 'run it without a Steam lobby', 'no Steam join: direct IP', 'Yes, no Steam: start it now', 'not signed in to Steam, direct IP'])
    assert.equal(mentionsSteam(none), false, none);
  for (const steam of ['host a Steam lobby and join it', 'leg 2 joins through a Steam invite', 'No direct IP, but a Steam host and join'])
    assert.equal(mentionsSteam(steam), true, steam);
  assert.equal(ownWords('Do it.\n\nFF Factory filed this for worker x on w1: only on computers signed in to Steam'), 'Do it.');
});

test('w3455: request_pair steam "none" followed by why says none; a reason that is not none still marks it', () => {
  for (const none of ['none', 'None.', 'none: a direct (non-Steam) host and join', 'no - direct IP', 'not needed', 'off'])
    assert.equal(saysNone(none), true, none);
  for (const some of ['a Steam lobby join', 'nonetheless a Steam host', 'notably a Steam invite', 'lobby'])
    assert.equal(saysNone(some), false, some);
});

test('w3455: remarkPair steam "none" drops a Steam mark and keeps its words unread; a reason sets it again', () => {
  const read = { legs: 2, for: 'w3315', steam: STEAM_READ };
  const r = remarkPair(read, { steam: 'none' });
  assert.equal(r.changed, true);
  assert.equal(r.pair.steam, undefined);
  assert.match(r.pair.noSteam ?? '', /^none: its legs need no Steam, as the dispatcher said \(decide_work pair_steam "none"\)$/);
  assert.doesNotMatch(pairText(r.pair), /Steam/);
  assert.match(r.was, /only on computers signed in to Steam/);
  assert.equal(remarkPair(r.pair, { steam: 'none' }).changed, false);
  const back = remarkPair(r.pair, { steam: 'a Steam lobby join' });
  assert.deepEqual(back.pair, { legs: 2, for: 'w3315', steam: 'a Steam lobby join' });
});

test('w3455: restatedSteam drops a stored mark that says none or was read from FF Factory\'s own words; saysNoSteam reads a person\'s "no Steam"', () => {
  const none = restatedSteam({ title: 't', brief: W3431, pair: { legs: 2, steam: 'none: a direct (non-Steam) host and join' } });
  assert.equal(none?.steam, undefined);
  assert.match(none?.noSteam ?? '', /^none: /);
  const read = restatedSteam({ title: 'Pair run for w3360', brief: W3392, pair: { legs: 2, steam: STEAM_READ } });
  assert.ok(read && read.steam === undefined && !read.noSteam);
  assert.equal(restatedSteam({ title: 't', brief: 'Both legs meet in a Steam lobby.', pair: { legs: 2, steam: STEAM_READ } }), undefined, 'its own words still name Steam');
  assert.equal(restatedSteam({ title: 't', brief: '', pair: { legs: 2, steam: 'a Steam lobby join' } }), undefined, 'a said reason stands');
  for (const yes of ['Yes, no Steam: start the planner rejoin run now', 'Yes, no Steam: start it when two computers have room', 'run it without Steam', 'a direct (non-Steam) host']) assert.equal(saysNoSteam(yes), true, yes);
  for (const no of ['go ahead', 'start it on two Steam computers', 'Steam is fine', 'nonsteamy']) assert.equal(saysNoSteam(no), false, no);
});
