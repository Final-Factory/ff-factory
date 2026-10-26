// A Live view staged again by the daemon itself (w1839, docs/live-view.md "Staged again without a turn"): the worker records
// once how it staged its view (a save to load, then game commands and editor snippets), and when a person opens the view
// while its editor is stopped or out of play mode, the daemon starts the editor, enters play mode, loads the save and runs
// the steps, with no worker turn.
//
// Ben, 2026-10-23 (w1839): "Just make the current Unity stream faster and keep it warm." The portal journal of the w1466
// view had its editor up at 00:17:33Z and its worker's turn to stage it again ending at 00:25:11Z: 7.5 of the minutes
// between a click and the first frame were that turn.
import { INSPECT_SNIPPET, parseLook } from './liveIdle.ts';
import { DEV_TIER_SNIPPET, type CommandReply, type GameChannel } from './live.ts';
import type { LiveStageStep } from '../shared/types.ts';

export type { LiveStageStep };

export const LIVE_STAGE_MAX_STEPS = 20;
export const LIVE_STAGE_MAX_TEXT = 4000;
const SAVE_NAME = /^[\w .,()+-]{1,120}$/;

/** A recipe from the live_view tool, checked: the steps it keeps, or why it refuses it. */
export function parseStage(raw: unknown): { steps: LiveStageStep[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'stage must be a list of steps' };
  if (raw.length > LIVE_STAGE_MAX_STEPS) return { error: `stage has ${raw.length} steps; at most ${LIVE_STAGE_MAX_STEPS}` };
  const steps: LiveStageStep[] = [];
  for (const [i, s] of raw.entries()) {
    const at = `stage step ${i + 1}`;
    if (!s || typeof s !== 'object') return { error: `${at} is not an object` };
    const o = s as Record<string, unknown>;
    const keys = ['load', 'ffauto', 'csharp'].filter((k) => k in o);
    if (keys.length !== 1) return { error: `${at} needs exactly one of load, ffauto or csharp` };
    const text = String(o[keys[0]] ?? '').trim();
    if (!text) return { error: `${at}: ${keys[0]} is empty` };
    if (text.length > LIVE_STAGE_MAX_TEXT) return { error: `${at}: ${keys[0]} is over ${LIVE_STAGE_MAX_TEXT} characters` };
    if (keys[0] === 'load') {
      if (i !== 0) return { error: `${at}: load must be the first step` };
      if (!SAVE_NAME.test(text)) return { error: `${at}: "${text.slice(0, 60)}" is not a save name (letters, digits, spaces and . , ( ) + - _ )` };
      steps.push({ load: text });
    } else if (keys[0] === 'ffauto') {
      steps.push({ ffauto: text.replace(/^ffauto:/, '') });
    } else {
      const until = o.until === undefined ? undefined : String(o.until);
      const timeoutS = o.timeoutS === undefined ? undefined : Number(o.timeoutS);
      if (timeoutS !== undefined && !(timeoutS > 0 && timeoutS <= 300)) return { error: `${at}: timeoutS must be 1 to 300 seconds` };
      steps.push({ csharp: text, ...(until ? { until } : {}), ...(timeoutS ? { timeoutS } : {}) });
    }
  }
  return { steps };
}

/** One line per step, for a tool answer or a log. */
export function stageSummary(steps: readonly LiveStageStep[]): string {
  if (!steps.length) return 'no steps';
  return steps.map((s) => ('load' in s ? `load "${s.load}"` : 'ffauto' in s ? `ffauto ${s.ffauto.slice(0, 60)}` : `csharp (${s.csharp.length} chars${s.until ? `, until "${s.until}"` : ''})`)).join('; ');
}

const MAIN_SCENE = 'Assets/Scenes/main.unity';

/**
 * Enter play mode in the game's main scene. The load menu does not reach the game from another scene (the game repo's
 * Documentation/Live-View-Knobs.md, "Staging"), and an open scene with unsaved changes is never thrown away.
 */
export const PLAY_SNIPPET = [
  'if (UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode) return "playing";',
  'if (UnityEditor.EditorApplication.isCompiling || UnityEditor.EditorApplication.isUpdating) return "wait: compiling or importing";',
  'var active = UnityEngine.SceneManagement.SceneManager.GetActiveScene();',
  `if (active.path != "${MAIN_SCENE}") {`,
  '  for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++)',
  '    if (UnityEngine.SceneManagement.SceneManager.GetSceneAt(i).isDirty) return "refused: an open scene has unsaved changes";',
  `  UnityEditor.SceneManagement.EditorSceneManager.OpenScene("${MAIN_SCENE}");`,
  '}',
  'UnityEditor.SessionState.SetBool(Behaviours.Multiplayer.AgentControl.AgentChannelHost.DevSessionStateKey, true);',
  'UnityEditor.EditorApplication.isPlaying = true;',
  'return "entering play mode";',
].join('\n');

/** The title screen has loaded, so a save can load (the lighting bench's wait, LightingBench.Audit.cs). */
export const TITLE_READY_SNIPPET = [
  'if (!UnityEngine.Application.isPlaying) return "wait: not playing";',
  'var s = UnityEngine.Object.FindFirstObjectByType<Behaviours.StartController>(UnityEngine.FindObjectsInactive.Include);',
  'return s != null && s.Loaded ? "ready" : "wait: title screen loading";',
].join('\n');

/** The game is in a world with its player and camera (the content shader bench's WaitForGame, SaveThumbnailCapture.IsInGame). */
export const IN_GAME_SNIPPET = [
  'if (!UnityEngine.Application.isPlaying) return "wait: not playing";',
  'var ready = FFCore.Extensions.Ecs.Ready && GameRunning.GameInitializer.InitialWorldSetupComplete && PlayerController.PlayersManager.LocalPlayerReady && PlayerController.PlayerCamera.Instance != null && !Serialization.SaveGameManager.IsWorldBeingReplaced;',
  'return ready ? "ready" : "wait: the save is loading";',
].join('\n');

export interface StageDeps {
  /** The sandbox editor's process id, or undefined while it is not running. */
  editorPid(): number | undefined;
  /** Starts the sandbox's editor (the pool's unity start: the Unity slot limit and the bench queue apply); its answer. */
  startEditor(): Promise<string>;
  /** Runs C# in the editor through its MCP bridge; resolves its answer or an error text, never throws. */
  bridge(code: string): Promise<string>;
  channel(pid: number): GameChannel | undefined;
  command(ch: GameChannel, text: string): Promise<CommandReply>;
  /** What it is doing now, for the view's detail ("setting the view up again: loading save …"). */
  progress(detail: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface StageLimits {
  /** For the editor to start and its bridge to answer (an editor start may wait in the bench queue). */
  editorMs: number;
  /** For play mode and the game's agent channel. */
  playMs: number;
  /** For the title screen. */
  titleMs: number;
  /** For a save to load. */
  loadMs: number;
  pollMs: number;
}

export const STAGE_LIMITS: StageLimits = { editorMs: 20 * 60_000, playMs: 3 * 60_000, titleMs: 2 * 60_000, loadMs: 4 * 60_000, pollMs: 1000 };

export interface StageResult {
  ok: boolean;
  /** What went wrong, or "staged". */
  detail: string;
  ms: number;
  /** How long each leg took (ms): editor, play, title, load, steps. */
  legs: Record<string, number>;
}

/** Stages a view again: the editor up, play mode in the main scene, the dev tier, the save, then the steps. Never throws. */
export async function restage(d: StageDeps, steps: readonly LiveStageStep[], lim: StageLimits = STAGE_LIMITS): Promise<StageResult> {
  const t0 = d.now();
  const legs: Record<string, number> = {};
  let mark = t0;
  const leg = (name: string) => {
    const now = d.now();
    legs[name] = now - mark;
    mark = now;
  };
  const fail = (detail: string): StageResult => ({ ok: false, detail, ms: d.now() - t0, legs });
  /** Polls fn until it answers a value, or the time runs out (undefined). */
  const until = async <T>(ms: number, fn: () => Promise<T | undefined> | T | undefined): Promise<T | undefined> => {
    const end = d.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (d.now() >= end) return undefined;
      await d.sleep(lim.pollMs);
    }
  };

  // 1. The editor, and its bridge answering.
  if (!d.editorPid()) {
    d.progress('setting the view up again: starting the editor');
    const started = await d.startEditor().catch((e: Error) => `not started: ${e.message}`);
    if (/not started|refused|cannot|could not/i.test(started) && !d.editorPid()) return fail(`the editor did not start: ${started}`);
  }
  let lastLook = '';
  const look = await until(lim.editorMs, async () => {
    if (!d.editorPid()) return undefined;
    const text = await d.bridge(INSPECT_SNIPPET);
    lastLook = text;
    const l = parseLook(text);
    return l && !l.compiling && !l.updating ? l : undefined;
  });
  if (!look) return fail(d.editorPid() ? `the editor's bridge did not answer in ${Math.round(lim.editorMs / 60_000)} min (${lastLook.slice(0, 120)})` : `the editor was not up after ${Math.round(lim.editorMs / 60_000)} min`);
  leg('editor');

  // 2. Play mode in the main scene, then the game's agent channel in the dev tier.
  const pid = d.editorPid()!;
  if (!look.playing) {
    d.progress('setting the view up again: entering play mode');
    let answer = '';
    const entered = await until(lim.playMs, async () => {
      answer = await d.bridge(PLAY_SNIPPET);
      if (/^refused/.test(answer)) return answer;
      return /^(playing|entering)/.test(answer) ? answer : undefined;
    });
    if (!entered) return fail(`play mode did not start (${answer.slice(0, 120)})`);
    if (/^refused/.test(entered)) return fail(`play mode was not entered: ${entered.replace(/^refused: /, '')}`);
  }
  let ch: GameChannel | undefined;
  let tier = '';
  const channel = await until(lim.playMs, async () => {
    ch = d.channel(pid);
    if (ch?.tier === 'all') return ch;
    // w2255: a plain play mode opens no channel (the game's AgentChannelHost.Bootstrap starts one only for the launch flag
    // or the Agent Control setting), so the snippet starts it too, not only moves an open one to the dev tier. Until the
    // game's channel host exists it answers "not playing" or "no channel host", and the next poll asks again.
    tier = await d.bridge(DEV_TIER_SNIPPET);
    ch = d.channel(pid);
    return ch?.tier === 'all' ? ch : undefined;
  });
  if (!channel) return fail(ch ? `the game's agent channel is not in the dev tier (${tier.slice(0, 120)})` : `the game opened no agent channel in play mode (${tier.slice(0, 120) || 'no answer'})`);
  leg('play');
  const cmd = async (text: string) => {
    const c = d.channel(pid) ?? channel;
    return d.command(c, text);
  };
  const snippetUntil = async (code: string, want: string, ms: number) => {
    let last = '';
    const ok = await until(ms, async () => {
      last = await d.bridge(code);
      return last.includes(want) ? true : undefined;
    });
    return ok ? undefined : last;
  };

  // 3. The save.
  let i = 0;
  const first = steps[0];
  if (first && 'load' in first) {
    d.progress(`setting the view up again: waiting for the title screen`);
    const title = await snippetUntil(TITLE_READY_SNIPPET, 'ready', lim.titleMs);
    if (title !== undefined) return fail(`the title screen did not load in ${Math.round(lim.titleMs / 1000)} s (${title.slice(0, 120)})`);
    leg('title');
    d.progress(`setting the view up again: loading the save "${first.load}"`);
    const r = await cmd(`game.loadsolo|${first.load}`);
    if (!r.ok) return fail(`the save "${first.load}" did not load: ${r.result || r.status}`);
    const loaded = await snippetUntil(IN_GAME_SNIPPET, 'ready', lim.loadMs);
    if (loaded !== undefined) return fail(`the save "${first.load}" was not in game after ${Math.round(lim.loadMs / 1000)} s (${loaded.slice(0, 120)})`);
    leg('load');
    i = 1;
  }

  // 4. The steps, in order.
  for (; i < steps.length; i++) {
    const s = steps[i];
    d.progress(`setting the view up again: step ${i + 1} of ${steps.length}`);
    if ('ffauto' in s) {
      const r = await cmd(s.ffauto);
      if (!r.ok) return fail(`step ${i + 1} (ffauto ${s.ffauto.slice(0, 60)}) failed: ${r.result || r.status}`);
    } else if ('csharp' in s) {
      if (s.until) {
        const last = await snippetUntil(s.csharp, s.until, (s.timeoutS ?? 30) * 1000);
        if (last !== undefined) return fail(`step ${i + 1} (csharp) did not answer "${s.until}" in ${s.timeoutS ?? 30} s: ${last.slice(0, 160)}`);
      } else {
        const answer = await d.bridge(s.csharp);
        if (bridgeFailed(answer)) return fail(`step ${i + 1} (csharp) failed: ${answer.slice(0, 160)}`);
      }
    }
  }
  leg('steps');
  return { ok: true, detail: 'staged', ms: d.now() - t0, legs };
}

/** bridgeExecute's answers that are not the snippet's own (server/unityHang.ts): an error, no bridge, a timeout. */
export function bridgeFailed(answer: string): boolean {
  return /^(error: |no bridge: |the editor did not answer in time|the bridge closed the connection|not a Unity MCP bridge)/.test(answer);
}

/** "editor 62.0 s, play 8.1 s, title 4.0 s, load 21.3 s, steps 0.4 s", for logs and answers. */
export function legsText(legs: Record<string, number>): string {
  return Object.entries(legs)
    .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`)
    .join(', ');
}
