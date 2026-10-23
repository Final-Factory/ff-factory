import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BenchTurn, closedRefusal, type BenchTurnDeps, type Holder, type TurnEditor, type TurnPlayer } from '../machine/benchTurn.ts';
import { GRACE_MIN, PersonPlay, personEnds, personFile, personHoldReason, personTicket, readPersonFile, STALE_MS, treeOf, type PersonPlaySettings } from '../machine/personPlay.ts';
import type { Proc } from '../machine/unity.ts';
import { checkPersonPlayLaunch } from './guard.ts';
import { machinePersonPlay, PERSON_PLAY_DEFAULTS } from './config.ts';
import { setAppConfig } from './appConfig.ts';
import { playHolds, playLine } from '../shared/personPlay.ts';
import type { PersonPlayReport } from '../shared/types.ts';

/**
 * w1894 (lothsahn's request, item 1 of w1785's ranked list): while lothsahn plays Final Factory on LothDesktop, FF
 * Factory's agents there stop taking the game's CPU, and resume after. One release build ran there at 27.4 fps quiet and
 * 12 to 15 fps while agents' players, editors and builds held 7.5 to 11.3 of its 16 threads (measured by w1785). The
 * daemon tells the person's game from the agents' players, holds an exclusive turn for it (machine/benchTurn.ts, w1829's),
 * and the portal places nothing there until a grace after the game closes.
 */

const T0 = Date.parse('2026-10-23T19:00:00Z');
const MIN = 60_000;
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'w1894-'));

function watch(o: { root?: string; settings?: Partial<PersonPlaySettings> } = {}) {
  const s = { now: T0, log: [] as string[], settings: { enabled: true, graceMinutes: GRACE_MIN, who: 'lothsahn', ...o.settings } as PersonPlaySettings };
  const w = new PersonPlay({ root: o.root, settings: () => s.settings, now: () => s.now, log: (l) => s.log.push(l) });
  return { s, w };
}

test('w1894: a person game seen holds until GRACE_MIN after it closes; seen again within the grace it is the same turn', () => {
  const { s, w } = watch();
  assert.equal(w.state(), undefined);
  w.seen([4242]);
  const st = w.state()!;
  assert.deepEqual([st.who, st.pids, st.since, st.until], ['lothsahn', [4242], T0, undefined]);
  s.now += 30 * MIN;
  w.seen([]);
  assert.equal(w.state()!.until, T0 + 30 * MIN + GRACE_MIN * MIN, 'the grace starts when the game is first seen gone');
  assert.match(s.log.join('\n'), /lothsahn's game closed: agents' work resumes at 19:40Z unless it starts again/);
  // A restart of the game within the grace: the same turn (its ticket stays, so nothing reopens and closes again).
  s.now += 2 * MIN;
  w.seen([5151]);
  assert.equal(w.state()!.since, T0);
  assert.equal(w.state()!.until, undefined);
  s.now += MIN;
  w.seen([]);
  s.now += GRACE_MIN * MIN - 1;
  assert.ok(w.state(), 'still in the grace');
  s.now += 1;
  assert.equal(w.state(), undefined, 'the grace has passed: work resumes');
  w.seen([]);
  assert.match(s.log.join('\n'), /the grace after lothsahn's game ended: agents' work resumes/);
  // A new game later is a new turn.
  s.now += MIN;
  w.seen([6000]);
  assert.equal(w.state()!.since, s.now);
});

test('w1894: off on the machine (machines.personPlay.enabled false) nothing is held, even with a game running', () => {
  const { s, w } = watch({ settings: { enabled: false } });
  w.seen([4242]);
  assert.equal(w.state(), undefined);
  s.settings.enabled = true;
  w.seen([4242]);
  assert.ok(w.state());
  s.settings.enabled = false;
  assert.equal(w.state(), undefined, 'turning it off lets the work go at once');
});

test('w1894: person.json holds new work while fresh, says who and until when, and holds nothing once stale or past its grace', () => {
  const root = tmpRoot();
  const { s, w } = watch({ root });
  assert.equal(personHoldReason(root, s.now), undefined);
  w.seen([4242]);
  const why = personHoldReason(root, s.now)!;
  assert.match(why, /^lothsahn is playing Final Factory on this PC \(game pid 4242, since 19:00Z; w1894: agents yield while a person plays here\); work resumes 10 min after the game closes$/);
  // The daemon stopped writing it (gone, or its look is off): it holds nothing, so no work waits on a dead daemon.
  assert.equal(personHoldReason(root, s.now + STALE_MS + 1), undefined);
  s.now += MIN;
  w.seen([]);
  assert.match(personHoldReason(root, s.now)!, /work resumes at 19:11Z \(the game closed; 10 min of grace\)/);
  assert.equal(personHoldReason(root, s.now + GRACE_MIN * MIN), undefined);
  // Written whole (no half file) and empty once nobody plays.
  s.now += GRACE_MIN * MIN;
  w.seen([]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(personFile(root), 'utf8'))), ['at']);
});

test('w1894: a daemon restart keeps a game seen just before it until its first look', () => {
  const root = tmpRoot();
  const a = watch({ root });
  a.w.seen([4242]);
  const b = watch({ root });
  b.s.now = T0 + 30_000;
  assert.equal(b.w.state()?.since, T0, 'the new daemon holds from the file');
  b.w.seen([]);
  assert.ok(b.w.state()?.until, 'its first look finds the game gone: the grace runs');
  assert.ok(readPersonFile(root, b.s.now));
});

// ---------------------------------------------------------------- the person's turn (machine/benchTurn.ts)

function personHolder(over: Partial<PersonPlaySettings> = {}, since = T0): Holder {
  const grace = over.graceMinutes ?? GRACE_MIN;
  return { ticket: personTicket(since), mode: 'exclusive', what: 'lothsahn playing Final Factory', pid: 4242, until: T0 + grace * MIN, person: { who: 'lothsahn', ends: personEnds({}, grace) } };
}

function turnHarness(o: { editors: TurnEditor[]; players?: TurnPlayer[]; procs?: Proc[]; builds?: { pid: number; sandbox: string }[] }) {
  const s = {
    holder: undefined as Holder | undefined,
    now: T0,
    editors: o.editors,
    closed: new Map<string, { at: number; ticket: string; reopenAt?: number }>(),
    calls: [] as string[],
    notes: [] as [string, string][],
    marks: [] as Record<string, string>[],
    log: [] as string[],
    restored: 0,
  };
  const procs = [...(o.procs ?? []), ...(o.players ?? []).map((p) => ({ pid: p.pid, ppid: 1, cmd: '' }))];
  const d: BenchTurnDeps = {
    holder: () => s.holder,
    editors: () => s.editors,
    closed: () => [...s.closed].map(([id, c]) => ({ id, ...c, starting: false })),
    players: () => o.players ?? [],
    procs: async () => procs,
    closeEditor: async (id, by, ticket) => {
      s.calls.push(`close ${id} for ${by}`);
      s.closed.set(id, { at: s.now, ticket });
      s.editors = s.editors.map((e) => (e.id === id ? { ...e, running: false } : e));
      return { closed: true, text: 'closed' };
    },
    reopenEditor: async (id) => {
      s.calls.push(`reopen ${id}`);
      s.closed.delete(id);
      return 'Queued (w1615)';
    },
    closePlayer: async (pid) => {
      s.calls.push(`quit player ${pid}`);
      return 'asked';
    },
    notePlayer: (session, text) => s.notes.push([session, text]),
    builds: () => o.builds ?? [],
    stopBuild: async (pid) => {
      s.calls.push(`STOP build ${pid}`);
      return 'ended';
    },
    lowerBuild: (pid) => {
      s.calls.push(`lower build ${pid}`);
      return 'dropped to idle priority';
    },
    restoreBuilds: () => {
      s.restored++;
      return 0;
    },
    noteSandbox: (id, text) => s.notes.push([id, text]),
    writeClosed: (m) => s.marks.push(m),
    log: (l) => s.log.push(l),
    now: () => s.now,
  };
  return { s, turn: new BenchTurn(d) };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test('w1894: a person game closes every sandbox editor, asks every worker player to quit, lowers builds without ending them, and leaves the person game alone', async () => {
  const { s, turn } = turnHarness({
    editors: [
      { id: 'slot1', running: true, pid: 11 },
      { id: 'slot2', running: true, pid: 12 },
      { id: 'slot3', running: false },
    ],
    players: [
      { pid: 501, session: 'aaaa1111', sandbox: 'slot1', slot: 'slot1-0' },
      { pid: 502, slot: 'slot2-1' },
      { pid: 4242 }, // the person's own game: no slot, no session
    ],
    builds: [{ pid: 700, sandbox: 'slot2' }],
  });
  await turn.tick();
  assert.equal(s.restored, 1, 'the first look puts back what a person turn before a restart lowered');
  s.holder = personHolder();
  await turn.tick();
  await settle();
  assert.deepEqual(s.calls.filter((c) => c.startsWith('close')).sort(), ['close slot1 for lothsahn playing Final Factory on this PC', 'close slot2 for lothsahn playing Final Factory on this PC']);
  assert.ok(s.calls.includes('quit player 501') && s.calls.includes('quit player 502'), 'every worker player is asked to quit (the holder has no session of its own)');
  assert.ok(!s.calls.includes('quit player 4242'), "the person's game is never touched");
  assert.ok(s.calls.includes('lower build 700') && !s.calls.some((c) => c.startsWith('STOP')), 'a build is lowered, never ended');
  assert.equal(turn.buildsLowered(), 1);
  const toWorker = s.notes.find(([who]) => who === 'aaaa1111')![1];
  assert.match(toWorker, /w1894: while a person plays the game on this machine/);
  assert.match(s.notes.find(([who]) => who === 'slot2')![1], /dropped to idle priority .* It is back at normal priority when the turn ends, 10 min after the game closes/);
  const refusal = s.marks.at(-1)!.slot1;
  assert.match(refusal, /closed at 19:00Z for lothsahn playing Final Factory on this PC \(w1894/);
  assert.match(refusal, /starts it again when the turn ends, 10 min after the game closes/);
  // A later look lowers what the build started since, but tells its workers once.
  s.now += 31_000;
  await turn.tick();
  assert.equal(s.calls.filter((c) => c === 'lower build 700').length, 1, 'no new listing for builds within PERSON_BUILD_LOOK_MS: it costs the game CPU');
  s.now += 2 * MIN;
  await turn.tick();
  assert.equal(s.calls.filter((c) => c === 'lower build 700').length, 2);
  assert.equal(s.notes.filter(([who]) => who === 'slot2').length, 1);
  // The turn ends: the editors reopen and the builds go back to normal priority.
  s.holder = undefined;
  await turn.tick();
  assert.deepEqual(s.calls.filter((c) => c.startsWith('reopen')).sort(), ['reopen slot1', 'reopen slot2']);
  assert.equal(s.restored, 2);
});

test('w1894: a timed run that ends while a person plays does not reopen the editors it closed; the person turn keeps them', async () => {
  const { s, turn } = turnHarness({ editors: [{ id: 'slot1', running: true, pid: 11 }, { id: 'slot3', running: true, pid: 13 }] });
  s.holder = { ticket: 't00000042', mode: 'exclusive', what: 'timed', pid: 900, sandbox: 'slot3', session: 'dec9a619', until: T0 + 30 * MIN };
  await turn.tick();
  await settle();
  assert.ok(s.closed.has('slot1'));
  s.holder = personHolder();
  await turn.tick();
  await settle();
  assert.ok(!s.calls.includes('reopen slot1'), "the timed run's mark stays under the person's turn");
  assert.ok(s.calls.includes('close slot3 for lothsahn playing Final Factory on this PC'), "the timed run's own editor closes now too");
});

test('w1894: the closed refusal names the person and when the turn ends', () => {
  const t = closedRefusal('lothsahn playing Final Factory on this PC', T0, T0 + MIN, false, { who: 'lothsahn', ends: 'at 19:20Z (the game closed; 10 min of grace)' });
  assert.match(t, /w1894/);
  assert.match(t, /at 19:20Z \(the game closed/);
  assert.doesNotMatch(t, /timed run/);
});

test('w1894: treeOf lists a build and everything under it', () => {
  const procs = [
    { pid: 700, ppid: 1 },
    { pid: 701, ppid: 700 },
    { pid: 702, ppid: 701 },
    { pid: 800, ppid: 1 },
  ];
  assert.deepEqual(treeOf(700, procs), [700, 701, 702]);
});

// ---------------------------------------------------------------- the guard, config and the portal's hold

test('w1894: while a person plays, the guard refuses a player started by its binary or player_slots.py, and a screen grab', () => {
  const busy = () => 'lothsahn is playing Final Factory on this PC (game pid 4242, since 19:00Z; w1894: agents yield while a person plays here); work resumes 10 min after the game closes';
  for (const cmd of [
    'V:/ffw/players/slot1-0/player/finalfactory.exe -ffAutomationRole solo',
    'python scripts/nightly/player_slots.py launch --detach V:/ffw/players/slot1-0/player -- -ffAutomationRole solo',
    'python scripts/nightly/player_slots.py --peer 0 launch build/ -- -x',
    'ffmpeg -f gdigrab -i desktop out.mp4',
  ])
    assert.match(checkPersonPlayLaunch(cmd, busy) ?? '', /^Refused \(w1894\): lothsahn is playing/, cmd);
  for (const cmd of ['git status', 'python scripts/nightly/player_slots.py firewall', 'npm test']) assert.equal(checkPersonPlayLaunch(cmd, busy), undefined, cmd);
  assert.equal(checkPersonPlayLaunch('V:/ffw/players/slot1-0/player/finalfactory.exe', () => undefined), undefined, 'nobody plays: no refusal');
});

test('w1894: machines.personPlay is on at LothDesktop (lothsahn) by default, off elsewhere, and set per machine', () => {
  assert.deepEqual(machinePersonPlay({}, 'lothdesktop'), { enabled: true, graceMinutes: 10, who: 'lothsahn' });
  assert.deepEqual(machinePersonPlay({}, 'beast'), { enabled: false, graceMinutes: 10 });
  assert.equal(PERSON_PLAY_DEFAULTS.lothdesktop, 'lothsahn');
  const dir = tmpRoot();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  const cfg = {} as Parameters<typeof setAppConfig>[1];
  setAppConfig(file, cfg, 'machines.personPlay.enabled', true, { machine: 'beast' });
  setAppConfig(file, cfg, 'machines.personPlay.who', 'Ben', { machine: 'beast' });
  setAppConfig(file, cfg, 'machines.personPlay.graceMinutes', 5);
  assert.deepEqual(machinePersonPlay(cfg, 'beast'), { enabled: true, graceMinutes: 5, who: 'Ben' });
  assert.deepEqual(machinePersonPlay(cfg, 'lothdesktop'), { enabled: true, graceMinutes: 5, who: 'lothsahn' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).machines.personPlay, { enabled: { beast: true }, who: { beast: 'Ben' }, graceMinutes: 5 });
  assert.throws(() => setAppConfig(file, cfg, 'machines.personPlay.graceMinutes', 0), /1 to 240/);
});

test('w1894: a machine where a person plays is held with who, since when and until when; list_machines says what the turn did', () => {
  const play: PersonPlayReport = { who: 'lothsahn', pids: [4242], since: '2026-10-23T19:00:00.000Z', graceMinutes: 10, editorsClosed: 3, playersAsked: 1, buildsLowered: 1 };
  const holds = playHolds([{ id: 'lothdesktop' }, { id: 'beast' }], (id) => (id === 'lothdesktop' ? play : undefined));
  assert.deepEqual(Object.keys(holds), ['lothdesktop']);
  assert.equal(holds.lothdesktop, 'lothsahn is playing Final Factory there since 19:00Z (w1894: agents yield there until 10 min after the game closes)');
  assert.match(playLine(play), /no new work is placed there and its workers' shells run on; 3 editor\(s\) closed, 1 player\(s\) asked to quit, 1 build\(s\) at idle priority; game pid 4242$/);
  const closed = playHolds([{ id: 'lothdesktop' }], () => ({ ...play, pids: [], until: '2026-10-23T19:40:00.000Z' })).lothdesktop;
  assert.match(closed, /its 10-minute grace ends at 19:40Z \(w1894: agents yield there until 19:40Z\)/);
});
