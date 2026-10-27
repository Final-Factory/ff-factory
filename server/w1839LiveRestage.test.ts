// w1839: the daemon stages a Live view again by itself (machine/liveStage.ts, server/live.ts, server/liveIdle.ts,
// machine/daemon.ts, shared/liveReady.ts). Ben, 2026-10-23: "Just make the current Unity stream faster and keep it warm."
// The worker records once how it staged its view (a recipe); a person who opens the view after its editor stopped gets it
// set up again with no worker turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSPECT_SNIPPET } from '../machine/liveIdle.ts';
import { DEV_TIER_SNIPPET, LiveSession, type CommandReply, type GameChannel, type LiveState } from '../machine/live.ts';
import { IN_GAME_SNIPPET, LIVE_STAGE_MAX_STEPS, loadSnippet, PLAY_SNIPPET, STAGE_LIMITS, TITLE_READY_SNIPPET, legsText, parseStage, restage, stageSummary, type LiveStageStep, type StageDeps, type StageLimits } from '../machine/liveStage.ts';
import { liveReady } from '../shared/liveReady.ts';
import type { LiveViewInfo, MachineSandbox, SessionInfo } from '../shared/types.ts';
import type { ToDaemon } from './machineProtocol.ts';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { LiveHub } from './live.ts';
import { LiveIdleCloser } from './liveIdle.ts';
import { createTestMachine, until } from './testMachine.ts';
import { fakeLiveGame } from './testLiveGame.ts';
import type { Config } from './config.ts';

// ---------------------------------------------------------------------------------------------------- parseStage

test('w1839: parseStage keeps a load-first recipe and refuses what the daemon could not run', () => {
  const ok = parseStage([{ load: 'ffa-9a5e3b28-live' }, { ffauto: 'ffauto:ui.hide|true' }, { ffauto: 'camera.focus|10|20|30' }, { csharp: 'return "x";', until: 'x', timeoutS: 60 }]);
  assert.deepEqual('steps' in ok && ok.steps, [{ load: 'ffa-9a5e3b28-live' }, { ffauto: 'ui.hide|true' }, { ffauto: 'camera.focus|10|20|30' }, { csharp: 'return "x";', until: 'x', timeoutS: 60 }], 'a leading ffauto: is stripped');
  assert.deepEqual(parseStage([]), { steps: [] });

  const err = (raw: unknown) => ('error' in parseStage(raw) ? (parseStage(raw) as { error: string }).error : undefined);
  assert.match(err('x') ?? '', /must be a list/);
  assert.match(err([{ ffauto: 'ui.hide|true' }, { load: 'a' }]) ?? '', /step 2: load must be the first step/);
  assert.match(err([{ load: 'a', ffauto: 'b' }]) ?? '', /needs exactly one of load, ffauto or csharp/);
  assert.match(err([{}]) ?? '', /needs exactly one of load, ffauto or csharp/);
  assert.match(err([{ ffauto: '   ' }]) ?? '', /ffauto is empty/);
  assert.match(err([{ load: 'a/../b' }]) ?? '', /not a save name/);
  assert.match(err([{ load: 'x'.repeat(121) }]) ?? '', /not a save name/);
  assert.match(err(Array.from({ length: LIVE_STAGE_MAX_STEPS + 1 }, () => ({ ffauto: 'ui.hide|true' }))) ?? '', /at most 20/);
  assert.match(err([{ csharp: 'return "x";', timeoutS: 0 }]) ?? '', /timeoutS must be 1 to 300/);
  assert.match(err([{ csharp: 'return "x";', timeoutS: 301 }]) ?? '', /timeoutS must be 1 to 300/);
  assert.match(err([{ csharp: 'return "x";', timeoutS: 300 }]) ?? 'fine', /fine/);
});

// ---------------------------------------------------------------------------------------------------- restage

const SAVE = 'ffa-9a5e3b28-live';
const STEP_CS = 'return "camera set";';

/** A stand-in editor and game: a fake clock that advances in sleep, and a log of what the replay asked, in order. */
function stand(o: { dirty?: boolean; neverInGame?: boolean; ffautoFails?: boolean; noBridgeForStep?: boolean; loadThrows?: boolean; channelClosed?: boolean; hostLate?: number; neverChannel?: boolean } = {}) {
  let clock = 0;
  const log: string[] = [];
  let up = false;
  let playing = false;
  let tier = 'player-safe';
  let titleAsks = 0;
  let loaded = false;
  // w2255: a play mode entered here starts at the title screen, where the game's channel refuses every command (its router's
  // "commands need a running game; the game is 'menu'") until a save is loaded.
  let atTitle = false;
  let bridgeUp = false;
  // w2255: like the real game, play mode opens no channel unless channelClosed is off (the fake's old default); then only
  // DEV_TIER_SNIPPET's StartChannel opens it, once the game's channel host exists (hostLate asks after play mode began).
  let opened = !o.channelClosed;
  let hostAsks = 0;
  const ch = (): GameChannel | undefined => (playing && opened ? { port: 1, token: 't', tier, pid: 77 } : undefined);
  const deps: StageDeps = {
    editorPid: () => (up ? 77 : undefined),
    startEditor: async () => {
      log.push('start-editor');
      up = true;
      return 'started';
    },
    bridge: async (code) => {
      if (code === INSPECT_SNIPPET) {
        log.push('look');
        if (!bridgeUp) {
          bridgeUp = true;
          return 'no bridge: none for this editor';
        }
        return `playing=${playing ? 'True' : 'False'}|compiling=False|updating=False|dirty=|untitled=0`;
      }
      if (code === PLAY_SNIPPET) {
        log.push('play');
        if (o.dirty) return 'refused: an open scene has unsaved changes';
        playing = true;
        atTitle = true;
        return 'entering play mode';
      }
      if (code === DEV_TIER_SNIPPET) {
        log.push('dev-tier');
        if (!playing) return 'not playing';
        if (o.neverChannel || hostAsks++ < (o.hostLate ?? 0)) return 'no channel host';
        opened = true;
        tier = 'all';
        return 'tier=all port=1';
      }
      if (code === TITLE_READY_SNIPPET) {
        log.push('title');
        return ++titleAsks < 2 ? 'wait: title screen loading' : 'ready';
      }
      if (code === loadSnippet(SAVE)) {
        log.push(`load:${SAVE}`);
        if (o.loadThrows) return 'error: FileNotFoundException: no such save';
        loaded = true;
        return 'loading';
      }
      if (code === IN_GAME_SNIPPET) {
        log.push('in-game');
        return loaded && !o.neverInGame ? 'ready' : 'wait: the save is loading';
      }
      log.push(`csharp:${code}`);
      if (o.noBridgeForStep) return 'no bridge: the editor is reloading';
      return code === STEP_CS ? 'camera set' : 'not yet';
    },
    channel: () => ch(),
    command: async (_c, text): Promise<CommandReply> => {
      log.push(`cmd:${text}`);
      if (atTitle && !loaded) return { ok: false, status: 409, result: "state_not_playable: commands need a running game; the game is 'menu'" };
      if (o.ffautoFails && text.startsWith('ui.hide')) return { ok: false, status: 200, result: 'bad_arguments: no such command' };
      return { ok: true, status: 200, result: 'ok' };
    },
    progress: (d) => log.push(`progress:${d}`),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  };
  const calls = () => log.filter((l) => !l.startsWith('progress:')).filter((l, i, a) => l !== a[i - 1]);
  return { deps, log, calls };
}

const LIM: StageLimits = { editorMs: 60_000, playMs: 5_000, titleMs: 5_000, loadMs: 3_000, pollMs: 1000 };
const RECIPE: LiveStageStep[] = [{ load: SAVE }, { ffauto: 'ui.hide|true' }, { csharp: STEP_CS, until: 'camera set', timeoutS: 10 }];

test('w1839: restage starts the editor, enters play mode, loads the save and runs the steps in order', async () => {
  const s = stand();
  const r = await restage(s.deps, RECIPE, LIM);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.detail, 'staged');
  assert.deepEqual(s.calls(), ['start-editor', 'look', 'play', 'dev-tier', 'title', `load:${SAVE}`, 'in-game', 'cmd:ui.hide|true', `csharp:${STEP_CS}`]);
  assert.deepEqual(Object.keys(r.legs), ['editor', 'play', 'title', 'load', 'steps']);
  assert.ok(r.legs.editor >= 1000, 'the bridge that did not answer first cost a poll');
  assert.ok(r.ms >= r.legs.editor + r.legs.title);
  assert.match(legsText(r.legs), /^editor \d+\.\d s, play \d+\.\d s, title \d+\.\d s, load \d+\.\d s, steps \d+\.\d s$/);
  assert.ok(s.log.some((l) => l === 'progress:setting the view up again: starting the editor'));
  assert.ok(s.log.some((l) => l.includes(`loading the save "${SAVE}"`)));
});

test('w1839: restage with no load skips the title and the save, and a game already in play mode is left alone', async () => {
  // Already playing: the look says so.
  const inPlay = stand();
  inPlay.deps.editorPid = () => 77;
  const bridge = inPlay.deps.bridge;
  inPlay.deps.bridge = async (code) => (code === INSPECT_SNIPPET ? 'playing=True|compiling=False|updating=False|dirty=|untitled=0' : bridge(code));
  inPlay.deps.channel = () => ({ port: 1, token: 't', tier: 'all', pid: 77 });
  const r = await restage(inPlay.deps, [{ ffauto: 'ui.hide|true' }], LIM);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(inPlay.calls(), ['cmd:ui.hide|true']);
  assert.deepEqual(Object.keys(r.legs), ['editor', 'play', 'steps']);
});

test('w1839: restage says why it failed, in the leg that failed', async () => {
  // A dirty scene is never thrown away.
  const dirty = await restage(stand({ dirty: true }).deps, RECIPE, LIM);
  assert.equal(dirty.ok, false);
  assert.match(dirty.detail, /^play mode was not entered: an open scene has unsaved changes/);

  // The save never reaches the game.
  const never = stand({ neverInGame: true });
  const slow = await restage(never.deps, RECIPE, LIM);
  assert.equal(slow.ok, false);
  assert.match(slow.detail, new RegExp(`^the save "${SAVE}" was not in game after 3 s \\(wait: the save is loading\\)`));
  assert.deepEqual(Object.keys(slow.legs), ['editor', 'play', 'title']);

  // w2255: a save the game cannot load says the bridge's answer.
  const noSave = await restage(stand({ loadThrows: true }).deps, RECIPE, LIM);
  assert.equal(noSave.ok, false);
  assert.equal(noSave.detail, `the save "${SAVE}" did not load: error: FileNotFoundException: no such save`);

  // A game command the game refuses.
  const refused = await restage(stand({ ffautoFails: true }).deps, RECIPE, LIM);
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /^step 2 \(ffauto ui\.hide\|true\) failed: bad_arguments: no such command/);

  // An editor snippet whose answer never contains what the step waits for.
  const unmatched = await restage(stand().deps, [{ load: SAVE }, { csharp: 'return "other";', until: 'ready', timeoutS: 3 }], LIM);
  assert.equal(unmatched.ok, false);
  assert.match(unmatched.detail, /^step 2 \(csharp\) did not answer "ready" in 3 s: not yet/);

  // The bridge answering "no bridge" is a failed step, not a done one.
  const nobridge = await restage(stand({ noBridgeForStep: true }).deps, [{ load: SAVE }, { csharp: 'return "camera";' }], LIM);
  assert.equal(nobridge.ok, false);
  assert.match(nobridge.detail, /^step 2 \(csharp\) failed: no bridge: the editor is reloading/);

  // An editor that never starts.
  const dead = stand();
  dead.deps.startEditor = async () => 'not started: needs 1, 0 free (3 of 3 in use)';
  const r = await restage(dead.deps, RECIPE, LIM);
  assert.equal(r.ok, false);
  assert.match(r.detail, /^the editor did not start: not started: needs 1, 0 free/);
});

test('w2255: a fresh editor whose play mode opens no channel: restage starts it and stages the view', async () => {
  // w2196 on m5/slot2, 2026-10-26 05:04Z: after the idle close the restage from a fresh editor failed with "the game opened
  // no agent channel in play mode": the game's AgentChannelHost.Bootstrap starts no channel without the launch flag or the
  // Agent Control setting, and the replay asked for the dev tier only once a channel was open.
  const s = stand({ channelClosed: true, hostLate: 2 });
  const r = await restage(s.deps, RECIPE, LIM);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(s.calls(), ['start-editor', 'look', 'play', 'dev-tier', 'title', `load:${SAVE}`, 'in-game', 'cmd:ui.hide|true', `csharp:${STEP_CS}`]);
  assert.equal(s.log.filter((l) => l === 'dev-tier').length, 3, 'asked again while the channel host was not there yet');

  // A game that never opens one says what the snippet last answered.
  const never = await restage(stand({ channelClosed: true, neverChannel: true }).deps, RECIPE, LIM);
  assert.equal(never.ok, false);
  assert.equal(never.detail, 'the game opened no agent channel in play mode (no channel host)');
});

test('w1839: the limits are the ones the docs name', () => {
  assert.deepEqual(STAGE_LIMITS, { editorMs: 20 * 60_000, playMs: 3 * 60_000, titleMs: 2 * 60_000, loadMs: 4 * 60_000, pollMs: 1000 });
  assert.equal(stageSummary(RECIPE), `load "${SAVE}"; ffauto ui.hide|true; csharp (${STEP_CS.length} chars, until "camera set")`);
});

// ---------------------------------------------------------------------------------------------------- LiveHub

const T0 = Date.parse('2026-10-23T08:00:00Z');

function hub(o: { canRestage?: boolean; live?: (op: Omit<Extract<ToDaemon, { type: 'live' }>, 'type' | 'id'>) => Promise<string> } = {}) {
  const ops: Omit<Extract<ToDaemon, { type: 'live' }>, 'type' | 'id'>[] = [];
  const logs: string[] = [];
  const failed: string[] = [];
  const session = { id: 's1', kind: 'worker', title: 'Ballista', machineId: 'beast', machineSandbox: 'slot5', requestedBy: { userId: 'ben', displayName: 'Ben' } } as unknown as SessionInfo;
  const h = new LiveHub({
    enabled: () => true,
    machines: {
      canLive: () => true,
      canRestage: () => o.canRestage ?? true,
      live: async (_m, op) => {
        ops.push(op);
        return o.live ? o.live(op) : op.op === 'stage' ? 'recipe kept: x' : 'ok';
      },
    },
    session: () => session,
    roleOf: (u) => (u === 'ben' ? 'owner' : undefined),
    changed: () => undefined,
    log: (l) => logs.push(l),
    restageFailed: (_i, d) => failed.push(d),
    now: () => T0,
  });
  return { h, ops, logs, failed, session, info: () => h.viewsFor('ben')[0] as LiveViewInfo };
}

test('w1839: live_view start refuses a bad recipe, keeps a good one and passes it to the daemon', async () => {
  const k = hub();
  const bad = await k.h.tool(k.session, { action: 'start', materials: ['M'], stage: [{ ffauto: 'a' }, { load: 'b' }] });
  assert.match(bad, /^The live view did not start: stage step 2: load must be the first step/);
  assert.equal(k.ops.length, 0, 'nothing reached the daemon');
  assert.equal(k.h.viewsFor('ben').length, 0);

  const good = await k.h.tool(k.session, { action: 'start', materials: ['M'], stage: [{ load: SAVE }, { ffauto: 'ui.hide|true' }] });
  assert.match(good, /^Live view started/);
  assert.match(good, /Its stage recipe is kept \(load "ffa-9a5e3b28-live"; ffauto ui\.hide\|true\)/);
  assert.deepEqual(k.ops[0].stage, [{ load: SAVE }, { ffauto: 'ui.hide|true' }]);
  assert.equal(k.info().stage, `load "${SAVE}"; ffauto ui.hide|true`);

  // No recipe: one sentence says how to get one.
  const k2 = hub();
  const none = await k2.h.tool(k2.session, { action: 'start', materials: ['M'] });
  assert.match(none, /Give it a stage recipe \(live_view stage\) so it comes back by itself, without your turn\./);
  assert.equal(k2.ops[0].stage, undefined);
  assert.equal(k2.info().stage, undefined);
});

test('w1839: live_view stage sets the recipe, restage replays it and status says how it went', async () => {
  const k = hub();
  await k.h.tool(k.session, { action: 'start', materials: ['M'] });
  assert.match(await k.h.tool(k.session, { action: 'restage' }), /no stage recipe/);
  assert.match(await k.h.tool(k.session, { action: 'stage', stage: [{ load: 'a/b' }] }), /^The recipe was not kept: .*not a save name/);

  assert.match(await k.h.tool(k.session, { action: 'stage', stage: [{ load: SAVE }, { ffauto: 'ui.hide|true' }] }), /^recipe kept: x/);
  assert.equal(k.ops.at(-1)?.op, 'stage');
  assert.deepEqual(k.ops.at(-1)?.stage, [{ load: SAVE }, { ffauto: 'ui.hide|true' }]);
  assert.match(k.info().stage ?? '', /^load "/);
  assert.match(await k.h.tool(k.session, { action: 'status' }), /Stage recipe: load "ffa-9a5e3b28-live"; ffauto ui\.hide\|true\./);

  const answer = await k.h.tool(k.session, { action: 'restage' });
  assert.equal(answer, 'Setting it up again now from your recipe (editor, play mode, save, steps). live_view status shows how it went and how long each leg took.');
  assert.equal(k.ops.at(-1)?.op, 'restage');
  assert.deepEqual(k.info().restaging, { at: new Date(T0).toISOString(), who: 'its worker' });
  assert.match(await k.h.tool(k.session, { action: 'status' }), /The daemon is setting it up again now/);
  // One at a time.
  assert.equal(await k.h.restage(k.info().liveId, 'Ben'), false);

  // The daemon's word: how it went.
  const id = k.info().liveId;
  k.h.staged('beast', { type: 'live_staged', liveId: id, ok: true, detail: 'staged', ms: 61_500, legs: { editor: 20_000, play: 8_000, title: 4_000, load: 29_000, steps: 500 } });
  assert.equal(k.info().restaging, undefined);
  assert.equal(k.info().staged?.ok, true);
  assert.ok(k.logs.some((l) => l === 'live view beast/slot5 (s1): staged again by the daemon in 61.5 s (editor 20.0 s, play 8.0 s, title 4.0 s, load 29.0 s, steps 0.5 s)'), k.logs.join('\n'));
  assert.match(await k.h.tool(k.session, { action: 'status' }), /Staged again ok at 08:00Z in 61\.5 s \(editor 20\.0 s/);
  assert.deepEqual(k.failed, []);

  // A failure calls restageFailed with the detail, and the status says why.
  assert.equal(await k.h.restage(id, 'Ben'), true);
  k.h.staged('beast', { type: 'live_staged', liveId: id, ok: false, detail: 'play mode was not entered: an open scene has unsaved changes', ms: 2000, legs: {} });
  assert.deepEqual(k.failed, ['play mode was not entered: an open scene has unsaved changes']);
  assert.ok(k.logs.some((l) => l.endsWith('could not be staged again: play mode was not entered: an open scene has unsaved changes')));
  assert.match(await k.h.tool(k.session, { action: 'status' }), /Staged again failed at 08:00Z: play mode was not entered/);
  // Another machine's word about this view is ignored.
  k.h.staged('other', { type: 'live_staged', liveId: id, ok: true, detail: 'staged', ms: 1, legs: {} });
  assert.equal(k.info().staged?.ok, false);
});

test('w1839: no restage without a daemon that offers it, and a refused op leaves the view as it was', async () => {
  const old = hub({ canRestage: false });
  await old.h.tool(old.session, { action: 'start', materials: ['M'], stage: [{ ffauto: 'ui.hide|true' }] });
  assert.equal(await old.h.restage(old.info().liveId, 'Ben'), false);
  assert.match(await old.h.tool(old.session, { action: 'restage' }), /needs an update/);

  const refusing = hub({ live: async (op) => { if (op.op === 'restage') throw new Error('this view has no stage recipe'); return 'ok'; } });
  await refusing.h.tool(refusing.session, { action: 'start', materials: ['M'], stage: [{ ffauto: 'ui.hide|true' }] });
  assert.equal(await refusing.h.restage(refusing.info().liveId, 'Ben'), false);
  assert.equal(refusing.info().restaging, undefined);
  assert.ok(refusing.logs.some((l) => /was not asked to set it up again: this view has no stage recipe/.test(l)));
});

test('w1839: a daemon that restarted starts the view again with its recipe, and a view taken back brings its recipe', async () => {
  const k = hub();
  await k.h.tool(k.session, { action: 'start', materials: ['M'], stage: [{ load: SAVE }, { ffauto: 'ui.hide|true' }] });
  k.ops.length = 0;
  await k.h.daemonHello('beast', []);
  assert.equal(k.ops[0].op, 'start');
  assert.deepEqual(k.ops[0].stage, [{ load: SAVE }, { ffauto: 'ui.hide|true' }]);

  // A portal that restarted: the daemon's own list carries the recipe.
  const fresh = hub();
  await fresh.h.daemonHello('beast', [{ liveId: 'old', sessionId: 's1', sandbox: 'slot5', fps: 15, width: 960, materials: ['M'], state: 'holding', detail: 'x', frames: 0, stage: [{ ffauto: 'ui.hide|true' }] }]);
  assert.equal(fresh.info().stage, 'ffauto ui.hide|true');
  assert.equal(await fresh.h.restage('old', 'Ben'), true);
  assert.deepEqual(fresh.ops.at(-1)?.op, 'restage');
});

test('w2255: a daemon that restarted mid-replay is asked for it again, and the view is not left "setting up" for good', async () => {
  const k = hub();
  await k.h.tool(k.session, { action: 'start', materials: ['M'], stage: [{ load: SAVE }, { ffauto: 'ui.hide|true' }] });
  const id = k.info().liveId;
  assert.equal(await k.h.restage(id, 'Ben'), true);
  assert.equal(k.info().restaging?.who, 'Ben');
  k.ops.length = 0;
  await k.h.daemonHello('beast', []);
  assert.deepEqual(k.ops.map((o) => o.op), ['start', 'restage']);
  assert.equal(k.info().restaging?.who, 'Ben');
  k.h.staged('beast', { type: 'live_staged', liveId: id, ok: true, detail: 'staged', ms: 1000, legs: {} });
  assert.equal(k.info().restaging, undefined);
  assert.equal(await k.h.restage(id, 'Ben'), true);

  // A new daemon that refuses the replay leaves the view free for the next opening, not marked for good.
  let calls = 0;
  const refusing = hub({ live: async (op) => { if (op.op === 'restage' && ++calls > 1) throw new Error('busy'); return 'ok'; } });
  await refusing.h.tool(refusing.session, { action: 'start', materials: ['M'], stage: [{ ffauto: 'ui.hide|true' }] });
  assert.equal(await refusing.h.restage(refusing.info().liveId, 'Ben'), true);
  await refusing.h.daemonHello('beast', []);
  assert.equal(refusing.info().restaging, undefined);
});

// ---------------------------------------------------------------------------------------------------- the wake

const later = () => new Promise((r) => setImmediate(r));

function closer(o: { unity: MachineSandbox['unity']; idleClosed?: boolean; restage?: boolean | 'throws' | 'absent'; others?: Record<string, SessionInfo['status']>; hold?: string; stage?: string }) {
  const sent: string[] = [];
  const woke: string[] = [];
  const logs: string[] = [];
  const asked: string[] = [];
  const statuses: Record<string, SessionInfo['status']> = { c1b21df6: 'stopped', ...(o.others ?? {}) };
  const sb = { id: 'slot5', unity: o.unity, ...(o.idleClosed ? { idleClosed: { at: '2026-10-23T07:07:00Z', minutes: 15 } } : {}), sessionIds: Object.keys(statuses) } as unknown as MachineSandbox;
  const c = new LiveIdleCloser({
    minutes: () => 15,
    views: () => [],
    sandbox: () => sb,
    session: (id) => (statuses[id] ? ({ id, status: statuses[id], machineId: 'beast', machineSandbox: 'slot5', lastActivityAt: '2026-10-23T07:00:00Z' } as SessionInfo) : undefined),
    wakePending: () => false,
    canClose: () => true,
    close: async () => 'skipped: test',
    send: (_id, text) => sent.push(text),
    hold: () => o.hold,
    woke: (id, who) => woke.push(`${id} ${who}`),
    ...(o.restage === 'absent'
      ? {}
      : {
          restage: async (id: string, who: string) => {
            asked.push(`${id} ${who}`);
            if (o.restage === 'throws') throw new Error('link down');
            return o.restage !== false;
          },
        }),
    log: (l) => logs.push(l),
    now: () => Date.parse('2026-10-23T07:50:00Z'),
  });
  const v = { liveId: 'l1', sessionId: 'c1b21df6', machineId: 'beast', sandbox: 'slot5', state: 'holding' as const, detail: 'the sandbox editor is not running', ...(o.stage ? { stage: o.stage } : {}) };
  return { c, v, sent, woke, logs, asked };
}

test('w1839: a person opens a view with a recipe whose editor stopped: the daemon sets it up, the worker is not woken', async () => {
  const k = closer({ unity: { state: 'stopped' }, stage: 'load "x"' });
  k.c.viewerOpened(k.v, 'Ben');
  assert.deepEqual(k.sent, [], 'not before the daemon answered');
  await later();
  assert.deepEqual(k.asked, ['l1 Ben']);
  assert.deepEqual(k.sent, []);
  assert.deepEqual(k.woke, ['l1 Ben']);
  assert.ok(k.logs.some((l) => l === "live idle: beast/slot5: Ben opened c1b21df6's Live view (its editor is stopped): the daemon sets it up again from its stage recipe (no worker turn)"), k.logs.join('\n'));
  // Once per stop, as before.
  k.c.viewerOpened(k.v, 'Ben');
  await later();
  assert.equal(k.asked.length, 1);

  // An editor the idle close shut: the same.
  const idle = closer({ unity: { state: 'stopped' }, idleClosed: true, stage: 'load "x"' });
  idle.c.viewerOpened(idle.v, 'Ben');
  await later();
  assert.deepEqual(idle.asked, ['l1 Ben']);
  assert.deepEqual(idle.sent, []);
});

test('w1839: the daemon cannot (no recipe, an old daemon, a request that failed): the worker gets today\'s wake', async () => {
  const no = closer({ unity: { state: 'stopped' }, restage: false });
  no.c.viewerOpened(no.v, 'Ben');
  await later();
  assert.equal(no.sent.length, 1);
  assert.match(no.sent[0], /^\[live view\] Ben opened your Live view, and it is not streaming: its editor is stopped\. Now start your editor \(mcp__machine__unity start\), put the game in play mode/);
  assert.match(no.sent[0], /\(Give the view a stage recipe with live_view stage, so the daemon sets it up again by itself without your turn\.\)$/, 'a view with no recipe is told to give one');
  assert.deepEqual(no.woke, ['l1 Ben']);

  const withRecipe = closer({ unity: { state: 'stopped' }, restage: false, stage: 'load "x"' });
  withRecipe.c.viewerOpened(withRecipe.v, 'Ben');
  await later();
  assert.doesNotMatch(withRecipe.sent[0], /stage recipe/);

  const throws = closer({ unity: { state: 'stopped' }, restage: 'throws', stage: 'load "x"' });
  throws.c.viewerOpened(throws.v, 'Ben');
  await later();
  assert.equal(throws.sent.length, 1);

  // A portal without the dependency behaves exactly as before: the wake at once, no clause.
  const absent = closer({ unity: { state: 'stopped' }, restage: 'absent' });
  absent.c.viewerOpened(absent.v, 'Ben');
  assert.equal(absent.sent.length, 1);
  assert.doesNotMatch(absent.sent[0], /stage recipe/);
});

test('w1839: a worker mid-turn in the sandbox, or a held computer, keeps today\'s path', async () => {
  const busy = closer({ unity: { state: 'stopped' }, others: { b2: 'running' }, stage: 'load "x"' });
  busy.c.viewerOpened(busy.v, 'Ben');
  await later();
  assert.deepEqual(busy.asked, [], 'a worker of the sandbox is mid-turn: no replay beside it');
  assert.equal(busy.sent.length, 1);

  const held = closer({ unity: { state: 'stopped' }, hold: 'building since 07:40Z (Urgent hotfix release; w1606): no new work until it is done', stage: 'load "x"' });
  held.c.viewerOpened(held.v, 'Ben');
  await later();
  assert.deepEqual(held.asked, []);
  assert.deepEqual(held.sent, []);

  // The idle-closed branch: a busy sandbox-mate means no replay, and the worker (stopped) is woken as before.
  const idle = closer({ unity: { state: 'stopped' }, idleClosed: true, others: { b2: 'starting' }, stage: 'load "x"' });
  idle.c.viewerOpened(idle.v, 'Ben');
  await later();
  assert.deepEqual(idle.asked, []);
  assert.equal(idle.sent.length, 1);
});

test('w1839: a replay that failed wakes the worker with the reason and asks it to fix the recipe', () => {
  const k = closer({ unity: { state: 'running' }, stage: 'load "x"' });
  k.c.restageFailed(k.v, 'the save "x" was not in game after 240 s (wait: the save is loading)');
  assert.equal(k.sent.length, 1);
  assert.match(k.sent[0], /^\[live view\] The daemon could not set your Live view up again from its stage recipe: the save "x" was not in game after 240 s \(wait: the save is loading\)\. /);
  assert.match(k.sent[0], /it is not streaming: the game is not in play mode\. Now put the game in play mode/);
  assert.match(k.sent[0], / Fix the recipe \(live_view stage\) and test it \(live_view restage\)\.$/);
  assert.ok(k.logs.some((l) => /the daemon could not set c1b21df6's Live view up again/.test(l)));

  const stopped = closer({ unity: { state: 'stopped' } });
  stopped.c.restageFailed(stopped.v, 'the editor did not start: x');
  assert.match(stopped.sent[0], /it is not streaming: its editor is stopped\. Now start your editor \(mcp__machine__unity start\)/);
});

// ---------------------------------------------------------------------------------------------------- readiness

test('w1839: a view the daemon is setting up again says "setting up", and only a live one says "go"', () => {
  const view = (o: Partial<LiveViewInfo>): LiveViewInfo => ({ liveId: 'l1', sessionId: 's1', machineId: 'beast', sandbox: 'slot5', state: 'holding', detail: 'setting the view up again: loading the save "x"', fps: 15, width: 960, materials: [], startedAt: '', updatedAt: '', frames: 0, ...o });
  const restaging = { at: '2026-10-23T08:00:00Z', who: 'Ben' };
  for (const unity of [{ state: 'stopped' }, { state: 'starting', detail: 'loading' }, { state: 'running' }] as MachineSandbox['unity'][]) {
    const r = liveReady(view({ restaging }), { sandbox: { unity } });
    assert.equal(r.kind, 'setting-up', unity.state);
    assert.equal(r.ready, false);
    assert.equal(r.badge, 'Live view: setting up');
    assert.equal(r.why, 'Setting the view up again: loading the save "x".');
    assert.match(r.back, /^It streams by itself once the save has loaded, with no worker turn \(usually 1 to 3 minutes; an editor start can wait in the bench queue\)/);
  }
  assert.equal(liveReady(view({ restaging }), { sandbox: { unity: { state: 'stopped' }, idleClosed: { at: '2026-10-23T07:07:00Z', minutes: 15 } } }).kind, 'setting-up');
  // A hold still wins: the editor cannot start while the computer is held.
  assert.equal(liveReady(view({ restaging, hold: 'building since 07:40Z (Urgent hotfix release; w1606): no new work until it is done' }), { sandbox: { unity: { state: 'stopped' } } }).kind, 'held');
  // Frames flowing: go, whatever else is set.
  const live = liveReady(view({ state: 'live', restaging }), { sandbox: { unity: { state: 'running' } } });
  assert.equal(live.kind, 'go');
  assert.equal(live.badge, 'Live view: go');
  assert.equal(liveReady(view({ state: 'holding' }), { sandbox: { unity: { state: 'stopped' } } }).kind, 'editor-stopped');
});

// ---------------------------------------------------------------------------------------------------- the daemon

test('w1839: the daemon answers restage at once, replays the recipe, and says how it went; an unknown op throws', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-restage-'));
  const cfg = {
    dataDir: dir,
    port: 0,
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    live: { enabled: true },
  } as unknown as Config;
  const game = fakeLiveGame({ width: 32, height: 18 });
  const bridged: string[] = [];
  const store = new Store(dir);
  const pc = await createTestMachine({
    sandboxes: ['alpha'],
    liveDeps: () => ({
      ...game.deps,
      command: async (ch, text) => (text.startsWith('ui.hide') ? (game.commands.push(text), { ok: true, status: 200, result: 'hidden' }) : game.deps.command!(ch, text)),
      bridge: async (code) => {
        bridged.push(code === INSPECT_SNIPPET ? 'look' : 'other');
        return code === INSPECT_SNIPPET ? 'playing=True|compiling=False|updating=False|dirty=|untitled=0' : 'ok';
      },
    }),
  });
  store.putMachine(pc.record({}));
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const info = { id: 'w1', kind: 'worker', title: 'Comet', machineId: 'pc', machineSandbox: 'alpha', requestedBy: { userId: 'kai', displayName: 'Kai' } } as unknown as SessionInfo;
  const failed: string[] = [];
  const h = new LiveHub({
    enabled: () => true,
    machines: { canLive: (m) => machines.canLive(m), canRestage: (m) => machines.canLiveRestage(m), live: (m, op, ms) => machines.live(m, op, ms) },
    session: (id) => (id === 'w1' ? info : undefined),
    roleOf: () => 'member',
    changed: () => undefined,
    restageFailed: (_i, d) => failed.push(d),
  });
  machines.onLiveFrames = (m, id, ws) => h.attachFrames(m, id, ws);
  machines.onLiveState = (m, msg) => h.onState(m, msg);
  machines.onLiveStaged = (m, msg) => h.staged(m, msg);
  t.after(async () => {
    game.stop();
    await pc.stop();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await pc.connect(machines);
  await until('the daemon offers the replay', () => machines.canLiveRestage('pc'), 20_000);

  const started = await h.tool(info, { action: 'start', materials: ['VfxComet'], fps: 20, width: 320, stage: [{ ffauto: 'ui.hide|true' }] });
  assert.match(started, /^Live view started/);
  const view = () => h.viewsFor('kai')[0];
  assert.equal(view().stage, 'ffauto ui.hide|true');
  await until('the view says live', () => view().state === 'live', 20_000);

  // The op answers at once; the replay's outcome comes as live_staged.
  const liveId = view().liveId;
  const op = { liveId, sessionId: 'w1', sandbox: 'alpha' };
  const answer = await machines.live('pc', { op: 'restage', ...op });
  assert.equal(answer, 'setting the view up again: ffauto ui.hide|true');
  await until('the daemon says how it went', () => view().staged !== undefined, 20_000);
  assert.equal(view().staged?.ok, true, String(view().staged?.detail));
  assert.deepEqual(Object.keys(view().staged!.legs), ['editor', 'play', 'steps']);
  assert.ok(game.commands.includes('ui.hide|true'), 'the step ran in the game');
  assert.equal(view().restaging, undefined);
  assert.deepEqual(failed, []);

  // A recipe replaced over the link, and one the daemon refuses.
  assert.equal(await machines.live('pc', { op: 'stage', ...op, stage: [{ ffauto: 'ui.hide|false' }] }), 'recipe kept: ffauto ui.hide|false');
  await assert.rejects(machines.live('pc', { op: 'stage', ...op, stage: [{ load: 'a' }, { load: 'b' }] }), /load must be the first step/);
  assert.equal(await machines.live('pc', { op: 'stage', ...op, stage: [] }), 'recipe kept: no steps');
  await assert.rejects(machines.live('pc', { op: 'restage', ...op }), /this view has no stage recipe/);
  await assert.rejects(machines.live('pc', { op: 'restage', liveId: 'nope', sessionId: 'w1', sandbox: 'alpha' }), /not running on the machine/);
  // An op the daemon does not know is refused, not taken for a start.
  await assert.rejects(machines.live('pc', { op: 'bogus' as never, ...op }), /unknown live op/);
  assert.equal(h.viewsFor('kai').length, 1);
});

test('w1839: while the daemon sets a view up again, every holding report carries its progress, not "not in play mode"', async () => {
  const states: [LiveState, string][] = [];
  const s = new LiveSession(15, 960, {
    editorPid: () => 7,
    channel: () => undefined,
    devTier: async () => '',
    command: async () => ({ ok: false, status: 0, result: '' }),
    frame: () => undefined,
    state: (st, d) => states.push([st, d]),
    now: () => Date.now(),
  }, 10, 200);
  await s.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.match(states.at(-1)?.[1] ?? '', /not in play mode/);
  s.setStaging('setting the view up again: waiting for the title screen');
  assert.deepEqual(states.at(-1), ['holding', 'setting the view up again: waiting for the title screen']);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(states.slice(states.findIndex(([, d]) => /waiting for the title/.test(d))).every(([, d]) => /waiting for the title/.test(d)), 'the 10 ms tick did not overwrite it');
  s.setStaging(undefined);
  await new Promise((r) => setTimeout(r, 50));
  await s.stop();
  const note = states.findIndex(([, d]) => /waiting for the title/.test(d));
  assert.ok(states.slice(note).some(([st, d]) => st === 'holding' && /not in play mode/.test(d)), 'the plain reason is back once the replay ends');
});
