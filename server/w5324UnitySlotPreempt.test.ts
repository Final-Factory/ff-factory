import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PREEMPT_RETRY_MS, UnitySlots, assess, editorInstancePid, grantFile, reqFile, type Place, type Preempt, type SlotRequest } from '../machine/unitySlots.ts';
import { BUSY_LINES, INSPECT_SNIPPET, LEAVE_PLAY_SNIPPET, SAVE_AND_QUIT_SNIPPET, idleCloseEditor } from '../machine/liveIdle.ts';
import type { Proc } from '../machine/unity.ts';
import type { WorkPriority } from '../shared/types.ts';

/*
 * w5324 (lothsahn, 2026-11-23: "If w5291 is frantic priority, how is it waiting for a slot?"; then "High priority work
 * should also preempt lower priority work as well, cleanly, of course"): the Unity slot queue ranks priority before
 * holders, a waiter takes the slot of an idle editor of strictly lower priority (closed cleanly through the editor, never
 * a kill, never while it runs a build or a test), the waiting reason names who holds the slots, and a Unity process
 * whose command line shows no project is matched to its place by Library/EditorInstance.json.
 */

const T0 = Date.parse('2026-11-23T18:00:00Z');
const HUB = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.19f1\\Editor';
let nextPid = 9000;
const editorProc = (pid: number, project: string, batch = false, ppid = 77777): Proc => ({ pid, ppid, name: 'Unity.exe', cmd: `"${HUB}\\Unity.exe"${batch ? ' -batchmode' : ''} -projectPath ${project}` });
const waiter = (id: string, at: number, over: Partial<SlotRequest> = {}): SlotRequest => ({ id, holder: `pid:${id}`, count: 1, pid: nextPid++, label: `build ${id}`, session: `s-${id}`, createdAt: T0 + at * 1000, ...over });
const place = (id: string, over: Partial<Place> = {}): Place => ({ holder: `sandbox:${id}`, path: `D:\\work\\ffsb\\${id}`, editorUp: true, session: `editor:${id}`, ...over });
/** Priorities by session ("s-<request>" or "editor:<sandbox>"); unlisted: low. */
const prio = (m: Record<string, WorkPriority>) => (session?: string) => m[session ?? ''] ?? 'low';
const work = (m: Record<string, string[]>) => (session?: string) => m[session ?? ''] ?? [];

test('w5324: a frantic request behind normal holders (an editor up, one stopped a moment ago, an older waiter) gets the next slot first', () => {
  // LothDesktop, limit 3: a's editor runs and a's worker wants a build, b stopped its editor to build, n1 is older.
  const places = [place('a'), place('b', { editorUp: false, priority: true })];
  const queued = [waiter('own', 1, { holder: 'sandbox:a' }), waiter('stop', 2, { holder: 'sandbox:b' }), waiter('n1', 3), waiter('f', 9)];
  const granted = waiter('h', -60, { grantedAt: T0 - 59_000 });
  const priorityOf = prio({ 's-own': 'normal', 's-stop': 'normal', 's-n1': 'normal', 's-f': 'frantic', 's-h': 'normal', 'editor:a': 'normal', 'editor:b': 'normal' });
  const procs = [editorProc(10, 'D:\\work\\ffsb\\a'), editorProc(11, 'D:\\other', true)];
  const full = assess({ platform: 'win32', procs, requests: [granted, ...queued], places, limit: 3, now: T0 + 10_000, priorityOf });
  assert.deepEqual(full.grant, []);
  assert.deepEqual(full.waiting.map((w) => w.id), ['f', 'own', 'stop', 'n1'], 'frantic first, then the holders, then the rest');
  // h's build ends: its slot goes to the frantic one, not to a holder of a lower priority.
  const freed = assess({ platform: 'win32', procs, requests: queued, places, limit: 3, now: T0 + 20_000, priorityOf });
  assert.deepEqual(freed.grant, ['f']);
  assert.deepEqual(freed.waiting.map((w) => w.id), ['own', 'stop', 'n1']);
});

test('w5324: a frantic waiter names the lowest-priority idle editor as the slot it takes, and the reason names who holds the slots', () => {
  const places = [place('a'), place('b')];
  const procs = [editorProc(10, 'D:\\work\\ffsb\\a'), editorProc(11, 'D:\\work\\ffsb\\b')];
  const a = assess({
    platform: 'win32',
    procs,
    requests: [waiter('f', 1)],
    places,
    limit: 2,
    now: T0 + 5000,
    priorityOf: prio({ 's-f': 'frantic', 'editor:a': 'normal', 'editor:b': 'low' }),
    requestsOf: work({ 'editor:a': ['w5293'], 'editor:b': ['w5300'] }),
  });
  assert.deepEqual(a.grant, []);
  assert.deepEqual(a.preempt, [{ holder: 'sandbox:b', priority: 'low', requests: ['w5300'], for: 'f', forPriority: 'frantic' }] satisfies Preempt[]);
  assert.deepEqual(a.heldBy, ['sandbox:a (w5293, normal)', 'sandbox:b (w5300, low)']);
  assert.equal(a.waiting[0].why, "needs 1, 0 free (2 of 2 in use); held by sandbox:a (w5293, normal), sandbox:b (w5300, low); takes the slot of sandbox:b's editor (low) once idle (w5324)");
});

test('w5324: high preempts normal (lothsahn: "Cover a high-over-normal case in your tests"), never an equal or higher priority', () => {
  const places = [place('a'), place('b')];
  const procs = [editorProc(10, 'D:\\work\\ffsb\\a'), editorProc(11, 'D:\\work\\ffsb\\b')];
  const run = (want: WorkPriority, a: WorkPriority, b: WorkPriority) => assess({ platform: 'win32', procs, requests: [waiter('w', 1)], places, limit: 2, now: T0 + 5000, priorityOf: prio({ 's-w': want, 'editor:a': a, 'editor:b': b }) }).preempt.map((p) => [p.holder, p.priority]);
  assert.deepEqual(run('high', 'normal', 'normal'), [['sandbox:a', 'normal']], 'high over normal: one is enough');
  assert.deepEqual(run('high', 'high', 'normal'), [['sandbox:b', 'normal']], 'only the lower one');
  assert.deepEqual(run('normal', 'normal', 'normal'), [], 'equal priority: never');
  assert.deepEqual(run('normal', 'high', 'urgent'), [], 'higher priority: never');
  assert.deepEqual(run('low', 'low', 'low'), [], 'low takes nothing');
});

test('w5324: a place running a granted batch build, an editor still starting, the waiter\'s own editor, or too few victims is never preempted', () => {
  const priorityOf = prio({ 's-f': 'frantic', 's-g': 'low', 'editor:a': 'low', 'editor:b': 'low' });
  // a's worker runs a build under its granted request: the place holds 2 (its editor and the build), so it is no victim.
  const g = waiter('g', -60, { holder: 'sandbox:a', grantedAt: T0 - 59_000 });
  const withBuild = assess({ platform: 'win32', procs: [editorProc(10, 'D:\\work\\ffsb\\a'), { pid: g.pid, ppid: 1, name: 'python.exe', cmd: 'python' }, editorProc(12, 'D:\\work\\pr', true, g.pid)], requests: [g, waiter('f', 1)], places: [place('a')], limit: 2, now: T0 + 5000, priorityOf });
  assert.deepEqual(withBuild.grant, []);
  assert.deepEqual(withBuild.preempt, [], 'a build is never cut off');
  // b's editor is starting: its slot is reserved, no process yet, nothing to close.
  const starting = assess({ platform: 'win32', procs: [], requests: [waiter('f', 1)], places: [place('b')], limit: 1, now: T0 + 5000, priorityOf });
  assert.deepEqual(starting.preempt, []);
  // The frantic run is a's own: its own editor is not closed for it.
  const own = assess({ platform: 'win32', procs: [editorProc(10, 'D:\\work\\ffsb\\a')], requests: [waiter('f', 1, { holder: 'sandbox:a' })], places: [place('a')], limit: 1, now: T0 + 5000, priorityOf });
  assert.deepEqual(own.preempt, []);
  // A peer run needs 2 and only one editor is lower: nothing is closed for nothing.
  const peer = assess({ platform: 'win32', procs: [editorProc(10, 'D:\\work\\ffsb\\a'), editorProc(11, 'D:\\other', true)], requests: [waiter('f', 1, { count: 2 })], places: [place('a')], limit: 2, now: T0 + 5000, priorityOf });
  assert.deepEqual(peer.preempt, []);
});

test('w5324: a Unity process whose command line shows no project is its place\'s editor by EditorInstance.json, not "started outside the slot gate"; one that is outside names its parent', () => {
  // LothDesktop, 2026-11-23 19:30Z: "4 of 3 ... Started outside the slot gate: interactive pid 47084, interactive pid 41472".
  const bare = (pid: number): Proc => ({ pid, ppid: 300, name: 'Unity.exe', cmd: '' });
  const hub: Proc = { pid: 300, ppid: 1, name: 'Unity Hub.exe', cmd: '"C:\\Program Files\\Unity Hub\\Unity Hub.exe"' };
  const places = [place('a', { editorPid: 47084 }), place('b', { editorPid: 41472 })];
  const mapped = assess({ platform: 'win32', procs: [hub, bare(47084), bare(41472)], requests: [], places, limit: 3, now: T0 });
  assert.deepEqual(mapped.outside, []);
  assert.equal(mapped.used, 2);
  const unmapped = assess({ platform: 'win32', procs: [hub, bare(47084), bare(41472)], requests: [], places: [place('a'), place('b')], limit: 3, now: T0 });
  assert.deepEqual(unmapped.outside.map((u) => [u.pid, u.parent]), [[47084, 'Unity Hub.exe'], [41472, 'Unity Hub.exe']]);
  // A project's own path still wins: a pid match never moves a process that names another project.
  const named = assess({ platform: 'win32', procs: [editorProc(47084, 'D:\\elsewhere')], requests: [], places: [place('a', { editorPid: 47084 })], limit: 3, now: T0 });
  assert.equal(named.outside.length, 1);
});

test('w5324: editorInstancePid reads Library/EditorInstance.json', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5324-ei-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(editorInstancePid(dir), undefined);
  fs.mkdirSync(path.join(dir, 'Library'));
  fs.writeFileSync(path.join(dir, 'Library', 'EditorInstance.json'), JSON.stringify({ process_id: 47084, version: '6000.3.19f1', app_path: 'x', app_contents_path: 'y' }));
  assert.equal(editorInstancePid(dir), 47084);
  fs.writeFileSync(path.join(dir, 'Library', 'EditorInstance.json'), '{"process_id": "nope"}');
  assert.equal(editorInstancePid(dir), undefined);
});

function mailbox(t: { after: (fn: () => void) => void }, preempt: (p: Preempt, why: string) => Promise<{ closed: boolean; text: string }>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5324-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const s = { clock: Date.now(), places: [place('a'), place('b')], procs: [editorProc(10, 'D:\\work\\ffsb\\a'), editorProc(11, 'D:\\work\\ffsb\\b')], log: [] as string[], events: [] as string[] };
  const slots = new UnitySlots({
    dir,
    platform: 'win32',
    procs: async () => s.procs,
    alive: () => true,
    now: () => s.clock,
    limit: () => 2,
    places: () => s.places,
    ramPct: () => undefined,
    priorityOf: prio({ 's-f': 'frantic', 'editor:a': 'normal', 'editor:b': 'low' }),
    requestsOf: work({ 's-f': ['w5291'], 'editor:a': ['w5293'], 'editor:b': ['w5300'] }),
    editorPid: () => undefined,
    preempt,
    log: (l) => s.log.push(l),
    onEvent: (e) => s.events.push(e),
  });
  fs.writeFileSync(reqFile(dir, 'f'), JSON.stringify({ v: 1, id: 'f', pid: process.pid, holder: 'pid:f', count: 1, label: 'Build 64 release', session: 's-f', createdAt: new Date(s.clock - 1000).toISOString() }));
  return { dir, slots, s };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('w5324: the arbiter closes the low idle editor for the frantic waiter, then grants it the freed slot', async (t) => {
  const asked: [Preempt, string][] = [];
  const box: { s?: ReturnType<typeof mailbox>['s'] } = {};
  const { dir, slots, s } = mailbox(t, async (p, why) => {
    asked.push([p, why]);
    // The editor saves and quits: its process goes and the pool marks it down.
    box.s!.procs = box.s!.procs.filter((x) => !x.cmd.includes('ffsb\\b'));
    box.s!.places = box.s!.places.map((pl) => (pl.holder === p.holder ? { ...pl, editorUp: false } : pl));
    return { closed: true, text: 'closed (nothing unsaved in its scenes; assets saved)' };
  });
  box.s = s;
  await slots.tick();
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0].holder, 'sandbox:b');
  assert.equal(asked[0][1], '"Build 64 release" (w5291), frantic, waits for a Unity slot, and its editor is low (w5300)');
  await slots.tick();
  assert.ok(fs.existsSync(grantFile(dir, 'f')), 'granted once the editor is gone');
  assert.ok(s.events.some((e) => /^Editor of sandbox:b closed cleanly for "Build 64 release"/.test(e)));
  assert.equal(asked.length, 1, 'closed once');
});

test('w5324: a close the editor skips (busy: a test run, a build, play mode) is asked again only after PREEMPT_RETRY_MS, and nothing is granted meanwhile', async (t) => {
  let n = 0;
  const { dir, slots, s } = mailbox(t, async () => {
    n++;
    return { closed: false, text: 'skipped: a test run is active' };
  });
  await slots.tick();
  await settle();
  await slots.tick();
  await settle();
  assert.equal(n, 1, 'not asked again at once');
  assert.ok(!fs.existsSync(grantFile(dir, 'f')));
  s.clock += PREEMPT_RETRY_MS;
  await slots.tick();
  await settle();
  assert.equal(n, 2);
  assert.ok(s.log.some((l) => /sandbox:b's editor not closed for f: skipped: a test run is active/.test(l)));
});

test('w5324: the clean close never kills a job: it skips play mode when asked to keep it, and the save-and-quit checks test runs and player builds in the same call', async () => {
  const calls: string[] = [];
  const res = await idleCloseEditor(
    {
      bridge: async (code) => {
        calls.push(code === INSPECT_SNIPPET ? 'look' : code === LEAVE_PLAY_SNIPPET ? 'leave' : code === SAVE_AND_QUIT_SNIPPET ? 'save+quit' : 'other');
        return code === INSPECT_SNIPPET ? 'playing=true|compiling=False|updating=False|dirty=|untitled=0' : 'ok';
      },
      editorPids: async () => [4242],
      personInputAgoMs: () => undefined,
      sleep: async () => undefined,
      now: () => T0,
      keepPlay: true,
    },
    0,
  );
  assert.equal(res.closed, false);
  assert.match(res.text, /skipped: it is in play mode/);
  assert.deepEqual(calls, ['look'], 'play mode was not left');
  for (const line of BUSY_LINES) assert.ok(SAVE_AND_QUIT_SNIPPET.includes(line), `the quit checks: ${line}`);
  assert.match(SAVE_AND_QUIT_SNIPPET, /IsRunActive[\s\S]*TestRunStatus[\s\S]*isBuildingPlayer[\s\S]*Exit/, 'checked before the quit');
});
