// w2358: ten queued render/perf fixes (w2346..w2355) sat "Queued (no room)" while beast had two free sandboxes and three
// free agent seats. lothsahn's standing rule: "We should not have idle slots if there is queued work".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsTimed } from '../shared/capacity.ts';
import type { Machine, MachineSandbox, SessionInfo, WorkItem } from '../shared/types.ts';
import { STRONG, overlapOf } from './work.ts';
import { PlaceAgain, keptWhy, placeFor, releaseStep, type PlaceFacts } from './placeAgain.ts';

const work = (title: string, brief = '', notes: string[] = []): WorkItem => ({ title, brief, notes: notes.map((text) => ({ text })), needs: 'game' }) as unknown as WorkItem;

test('w2358: a requester\'s "any OS" note clears the Mac a brief only implied', () => {
  // w2346 as filed (2026-10-27 07:54Z): its brief cites earlier data from m3, so it read as timed work on darwin and beast
  // ("beast is not on macOS, which its timed work names") could not take it.
  const brief = 'Measured by w2332 on m3 (release player, master f3f76ac, 1920x1080, empty new game).\nDone when: fps before/after on the same machine and plan (scripts/bench/zoom_run.sh), labelled measured.\nHold the bench lock briefly.';
  assert.equal(needsTimed(work('Cheaper shadows: shadow map size and distance', brief)), 'darwin', 'as filed, the brief alone names m3');
  const note = 'Clarification from the orchestrator: "the same machine" means before and after are measured on one machine, any OS. m3 is not required. Measure on whichever computer takes the timed run.';
  assert.equal(needsTimed(work('Cheaper shadows: shadow map size and distance', brief, [note])), 'any', 'the note, newest, says any OS');
  // A note that names an OS again after the "any OS" one rules.
  assert.equal(needsTimed(work('Benchmark the paste', 'Any OS is fine.', ['Please do it on the Mac after all.'])), 'darwin');
  // The dispatcher's brief (text) is the newest word.
  assert.equal(needsTimed(work('Benchmark the paste on the Mac'), 'Any OS is fine for this one.'), 'any');
});

test('w2358: a mention that rules an OS out names none', () => {
  assert.equal(needsTimed(work('Benchmark the paste', 'm3 is not required.')), 'any');
  assert.equal(needsTimed(work('Benchmark the paste', 'Not the Mac; the Windows player.')), 'win32');
  // Unchanged: an OS named plainly still rules, and both named is any.
  assert.equal(needsTimed(work('Timed A/B of the Mac player on m3')), 'darwin');
  assert.equal(needsTimed(work('Perf A/B of the belt cache', 'probe_ab_win.sh on beast, then the Mac')), 'any');
});

// ---------------------------------------------------------------- causes 2 to 4: what kept sandboxes from being room

const NOW = Date.parse('2026-10-27T08:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const worker = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ id, kind: 'worker', machineId: 'beast', machineSandbox: 'slot3', title: id, status: 'stopped', permissionMode: 'default', createdAt: iso(NOW - 3600_000), lastActivityAt: iso(NOW - 20 * MIN), turns: 3, costUsd: 1, pendingPermissions: [], ...over });
const sandbox = (id: string, over: Partial<MachineSandbox> = {}, git: Partial<NonNullable<MachineSandbox['git']>> = {}): MachineSandbox => ({ id, branch: `sandbox/${id}`, base: 'origin/master', path: `/sb/${id}`, purpose: id, status: 'ready', createdAt: iso(NOW - 86_400_000), unity: { state: 'stopped' }, sessionIds: [], git: { branch: `sandbox/${id}-w1`, dirty: 0, untracked: 0, at: iso(NOW - MIN), ...git }, ...over });
const facts = (sessions: SessionInfo[], o: Partial<PlaceFacts> & { liveIds?: string[] } = {}): PlaceFacts => ({ unityHolders: [], now: NOW, ...o, sessions, live: (id) => (o.liveIds ?? []).includes(id) });
const DONE = 'its requests are closed (w2281 done)';

test('w2358: a pair leg\'s clean detached HEAD does not keep a worker whose work is over (biscuit/slot2, d54d715f); uncommitted work there still does', () => {
  const d = worker('d54d715f', { machineSandbox: 'slot2', heldSince: iso(NOW - 45 * MIN) });
  const over = { over: () => DONE };
  const detached = sandbox('slot2', {}, { branch: 'detached HEAD' });
  assert.equal(keptWhy(d, detached, facts([d], over)), undefined);
  assert.deepEqual(releaseStep(d, detached, { ...facts([d], over), workOver: DONE }), { do: 'release', why: `its work is over: ${DONE}`, branch: 'detached HEAD' });
  assert.match(keptWhy(d, sandbox('slot2', {}, { branch: 'detached HEAD', dirty: 2 }), facts([d], over)) ?? '', /not on a branch/, 'something uncommitted: kept');
  assert.match(keptWhy(d, detached, facts([d])) ?? '', /not on a branch/, 'work not over: kept as before');
});

test('w2358: an agent-seat worker (w1098) releases despite the game tree it sits beside (biscuit/slot2, dafd0fe0 on w2191)', () => {
  const a = worker('dafd0fe0', { machineSandbox: 'slot2', heldSince: iso(NOW - 45 * MIN) });
  const sb = sandbox('slot2', {}, { branch: 'detached HEAD', dirty: 3 });
  const f = { ...facts([a]), workOver: DONE };
  assert.equal(releaseStep(a, sb, f), undefined, 'a game worker is kept by the tree');
  assert.deepEqual(releaseStep(a, sb, { ...f, agentOnly: () => true }), { do: 'release', why: `its work is over: ${DONE}`, branch: 'detached HEAD' });
});

test('w2358: a worker whose work is over is not kept by another agent there or by that agent\'s batch run (beast/slot2, bfa0f5c7)', () => {
  const b = worker('bfa0f5c7', { machineSandbox: 'slot2' });
  const other = worker('c0ffee00', { machineSandbox: 'slot2', status: 'running' });
  const sb = sandbox('slot2');
  const f = facts([b, other], { liveIds: ['c0ffee00'], unityHolders: ['sandbox:slot2'] });
  assert.equal(keptWhy(b, sb, { ...f, over: () => 'its requests are closed (w2311, w2325 done)' }), undefined);
  assert.match(keptWhy(b, sb, f) ?? '', /batch run of that sandbox is in flight/, 'work not over: the run keeps it');
});

test('w2358: a co-tenant that waits on CI, a deploy or a person releases too, so it keeps nobody', () => {
  const a = worker('a1', { wakeAt: iso(NOW + 9 * 3600_000) });
  const b = worker('b2', { wakeAt: iso(NOW + 10 * MIN) });
  const sb = sandbox('slot3');
  assert.match(keptWhy(a, sb, facts([a, b])) ?? '', /agent b2 works there too/);
  assert.equal(keptWhy(a, sb, facts([a, b], { waitOf: (s) => (s.id === 'b2' ? 'it waits on CI on PR #1' : undefined) })), undefined);
});

function deps(sessions: SessionInfo[], sbs: MachineSandbox[], o: Partial<ConstructorParameters<typeof PlaceAgain>[0]> = {}): ConstructorParameters<typeof PlaceAgain>[0] {
  const m = { id: 'beast', sandboxes: sbs } as unknown as Machine;
  return { sessions: () => sessions, machine: () => m, machines: () => [m], isLive: () => false, online: () => true, unityHolders: () => [], workOver: () => undefined, keepLive: () => undefined, queued: () => false, stopLive: () => undefined, stopEditor: async () => undefined, switchBranch: async () => ({ notes: [] }), save: () => undefined, saveMachine: () => undefined, note: () => undefined, drain: () => undefined, canSave: () => true, now: () => NOW, ...o };
}

test('w2358: uncommitted work nobody holds (beast/slot3\'s main.unity after d2d9c644\'s release) is saved on its branch, and the sandbox is room again; never with the editor open, an agent there or a run in flight', async () => {
  const branch = 'sandbox/slot3-w2341';
  const d2 = worker('d2d9c644', { placeReleased: { at: iso(NOW - 10 * MIN), sandbox: 'slot3', branch, why: 'it waits on w2342' } });
  const sb = sandbox('slot3', {}, { branch, dirty: 1 });
  const saves: string[] = [];
  const notes: string[] = [];
  const freed: string[] = [];
  const saveWork = async (m: string, s: string, b: string, message: string, sid?: string) => (saves.push(`${m}/${s} ${b} ${sid ?? '-'}: ${message.split('\n')[0]}`), { sha: 'abc1234', files: 1, pushed: true, notes: ['committed 1 file(s)', `pushed ${b}`] });
  const run = async (sessions: SessionInfo[], sbs: MachineSandbox[], o: Partial<ConstructorParameters<typeof PlaceAgain>[0]> = {}) => {
    const p = new PlaceAgain(deps(sessions, sbs, { saveWork, note: (id, t) => void notes.push(`${id}: ${t}`), freed: (w) => void freed.push(w), ...o }));
    p.tick();
    await Promise.all(p.pending);
  };
  // What keeps it: the editor open, a batch run, an agent there that is not released, a machine whose daemon cannot save.
  await run([d2], [sandbox('slot3', { unity: { state: 'running' } }, { branch, dirty: 1 })]);
  await run([d2], [sb], { unityHolders: () => ['sandbox:slot3'] });
  await run([d2, worker('e1', { status: 'idle' })], [sb], { isLive: (id) => id === 'e1' });
  await run([d2], [sb], { canSave: () => false });
  await run([d2], [sandbox('slot3', {}, { branch: 'detached HEAD', dirty: 1 })]);
  assert.deepEqual(saves, []);
  await run([d2], [sb]);
  assert.deepEqual(saves, ['beast/slot3 sandbox/slot3-w2341 -: FF Factory: saved the uncommitted work left in beast/slot3 (w2358)']);
  assert.deepEqual(d2.savedWork, { sha: 'abc1234', files: 1, pushed: true, branch, at: iso(NOW) });
  assert.match(notes[0]!, /^d2d9c644: Uncommitted work left on its branch sandbox\/slot3-w2341 in beast\/slot3/);
  assert.deepEqual(freed, ['sandbox beast/slot3 saved and free']);
});

test('w2358: once saved, the released worker waiting on beast (9524a4bc, w2335) takes the sandbox the dirty tree had kept from it', () => {
  const w = worker('9524a4bc', { machineSandbox: 'slot9', placeReleased: { at: iso(NOW - 30 * MIN), sandbox: 'slot9', branch: 'sandbox/slot9-w2335', why: 'x' } });
  const m = (dirty: number) => ({ id: 'beast', sandboxes: [sandbox('slot3', {}, { dirty })] });
  assert.match(JSON.stringify(placeFor(w, m(1), facts([w]))), /"wait"/);
  assert.equal((placeFor(w, m(0), facts([w])) as { sandbox: MachineSandbox }).sandbox?.id, 'slot3');
});

test('w2358: sibling fixes from one profiling run are not the same work as each other; naming the request itself still is', () => {
  const entry = (ref: string, title: string, keys: string[]) => ({ ref, kind: 'work' as const, title, keys: [...keys, `work:${ref}`] });
  const shadows = { keys: ['work:w2332'], title: 'Cheaper shadows: shadow map size and distance' };
  const o = overlapOf(shadows, entry('w2334', 'Fewer draw calls for belt items', ['work:w2332']));
  assert.ok(o && o.score < STRONG, JSON.stringify(o));
  assert.equal(o!.why, 'both name request w2332');
  assert.equal(overlapOf(shadows, entry('w2332', 'Profile the render frame on m3', []))?.score, 1, 'it names that request: same work');
  assert.ok((overlapOf(shadows, entry('w2340', 'Cheaper shadows: shadow distance', ['work:w2332']))?.score ?? 0) >= STRONG, 'a sibling with a similar title is strong');
  // A worker on that request is still the same work (its keys are its requests').
  assert.equal(overlapOf(shadows, { ref: 'd2d9c644', kind: 'session', title: 'w2332: profile', keys: ['work:w2332'] })?.score, 1);
});
