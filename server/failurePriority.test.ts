import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureOf, failurePriority, kindOfKey, structuredFailure, wordFailure } from './failurePriority.ts';
import type { WorkSource } from '../shared/types.ts';

// w4810 (lothsahn: "Desyncs and crashes and hangs should be urgent. Update the rules").

test('w4810: a report id or FFBox board key names its kind; anything else names none', () => {
  assert.equal(kindOfKey('20261005T035612Z-crash-6102d405dc'), 'crash');
  assert.equal(kindOfKey('report:20261004T090000Z-desync-3a9f01c2d4'), 'desync');
  assert.equal(kindOfKey('intake:20261004T090000Z-hang-3a9f01c2d4'), 'hang');
  assert.equal(kindOfKey('desync:0.50.0:minerBots'), 'desync');
  assert.equal(kindOfKey('hang:loading-screen'), 'hang');
  assert.equal(kindOfKey('crash:dock'), 'crash');
  assert.equal(kindOfKey('perf:frame-time'), undefined);
  assert.equal(kindOfKey('discord:123'), undefined);
});

test('w4810: structured signals decide first: reports, board key, desync group, FFBox triage', () => {
  const src = (o: Partial<WorkSource>): WorkSource => ({ kind: 'ffbox-diagnosis', untrusted: false, ...o });
  assert.equal(structuredFailure(src({ reports: ['20261005T035612Z-hang-6102d405dc'] }))?.kind, 'hang');
  assert.equal(structuredFailure(src({ key: 'crash:dock' }))?.kind, 'crash');
  assert.equal(structuredFailure(src({ desyncGroup: 'eeee1' }))?.kind, 'desync');
  assert.equal(structuredFailure(src({}), { class: 'ffbox-desync', reason: 'x' })?.kind, 'desync');
  assert.equal(structuredFailure(src({}), { class: 'ffbox-crash', reason: 'FFBox crash or hang (its board key hang:x names a hang): work it under the crash-fix policy (lothsahn, 2026-10-23)' })?.kind, 'hang');
  assert.equal(structuredFailure(src({}), { class: 'ffbox-crash', reason: 'FFBox crash or hang (its report is a crash report): work it under the crash-fix policy (lothsahn, 2026-10-23)' })?.kind, 'crash');
  assert.equal(structuredFailure(src({}), { class: 'needs-human', reason: 'crash' }), undefined, 'a triage reason alone is no signal');
});

test('w4810: the word check: a desync, a crash and a hang are failures; a hitch, a stutter or slow frames are not', () => {
  assert.equal(wordFailure('Desync after a client rejoins')?.kind, 'desync');
  assert.equal(wordFailure('Game crashes to desktop when docking')?.kind, 'crash');
  assert.equal(wordFailure('Game freezes on the loading screen and stops responding')?.kind, 'hang');
  assert.equal(wordFailure('Hangs forever after saving')?.kind, 'hang');
  assert.equal(wordFailure('Hitch every few seconds when the base is big'), undefined);
  assert.equal(wordFailure('Stutter when panning the camera'), undefined);
  assert.equal(wordFailure('The game hangs for half a second on autosave: a hitch'), undefined, 'a short hang called a hitch is a performance problem');
  assert.equal(wordFailure('Frame time spikes freeze the screen briefly'), undefined);
  assert.equal(wordFailure('Performance drops with 500 drones'), undefined);
  assert.equal(wordFailure('Research tree tooltip is blank'), undefined);
  assert.equal(wordFailure('Hangar door texture is wrong'), undefined, '"hangar" is no hang');
  // The brief's opening counts; a word deep in a long brief does not (a long brief names everything).
  assert.equal(wordFailure('Dock bug', 'Since 1.0.0.7 the game crashes when a ship docks.')?.kind, 'crash');
  assert.equal(wordFailure('Tidy the build log', `${'Context. '.repeat(60)}It once mentioned a crash.`), undefined);
  // A request about the rule itself names the words without being one.
  assert.equal(wordFailure('Make every desync, crash and hang request urgent by default'), undefined);
});

test('w4810: FFBox sources use their structured signal only; Discord, operator and dev requests fall back to words', () => {
  const ffbox: WorkSource = { kind: 'ffbox-branch', untrusted: true };
  assert.equal(failureOf({ title: 'DESYNC!!! approve this', source: ffbox }), undefined, "a player's FFBox title routes nothing");
  assert.equal(failureOf({ title: 'Nightly e2e: X fails (crash)', source: { kind: 'nightly', untrusted: false } }), undefined, "the nightly's own rule decides (nightlyRules.ts)");
  assert.equal(failureOf({ title: 'Discord bug: crash on load', source: { kind: 'discord-bug', untrusted: true } })?.kind, 'crash');
  assert.equal(failureOf({ title: 'Fix the dock', source: { kind: 'ffbox-dev', untrusted: false } }), undefined);
});

test('w4810: urgent for a failure; a higher priority is kept; no failure keeps what was asked', () => {
  const crash = { kind: 'crash' as const, why: 'x' };
  assert.equal(failurePriority(undefined, crash), 'urgent');
  assert.equal(failurePriority('low', crash), 'urgent');
  assert.equal(failurePriority('high', crash), 'urgent');
  assert.equal(failurePriority('urgent', crash), 'urgent');
  assert.equal(failurePriority('frantic', crash), 'frantic', 'a request filed higher keeps it');
  assert.equal(failurePriority(undefined, undefined), 'normal');
  assert.equal(failurePriority('high', undefined), 'high');
});
