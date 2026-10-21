import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsBuild, URGENT_RELEASE_WORDS } from '../shared/capacity.ts';
import { RELEASE_RULES } from './releaseLanes.ts';
import { BuildPlans, liveViewNotice, type BuildDeps } from './buildPlans.ts';
import type { SessionInfo, WorkItem } from '../shared/types.ts';

/**
 * w1639, lothsahn, 2026-10-20: "Release builds should be handed by ffbox. We should update the version and just let ffbox
 * build it. But that can take up to 90m because ffbox is slow. If we need an urgent build, we should be able to ask beast or
 * Lothdesktop to build it for us. For that, we need to kick everyone else off the box (or at least have them pause) and then
 * do the release directly on the box and upload to steam. We need to make sure when that happens that ffbox doesn't see the
 * version update and do it's own release. ... Then Ben and I can ask for a release (ffbox) or a quick or urgent release
 * (beast, if offline, LothDesktop)".
 */

const work = (title: string, brief = ''): WorkItem => ({ title, brief, notes: [], needs: 'game' }) as unknown as WorkItem;

test('w1639: "a release" is FFBox\'s and builds nothing here; "a quick release" or "an urgent release" is the urgent lane', () => {
  for (const t of ['Release 1.0.0.12', 'Cut a release for the testers', 'Push a new dev build', 'Bump the version and run ci-release', 'Release build 113'])
    assert.equal(needsBuild(work(t)), false, t);
  for (const t of ['Quick release of 1.0.0.12', 'Urgent release: the save fix', 'an urgent build for Ben', 'Run the urgent-release lane on BEAST', 'quick dev build please'])
    assert.equal(needsBuild(work(t)), true, t);
  assert.ok(!URGENT_RELEASE_WORDS.test('a quick fix to the release notes'));
});

test('w1639: read_rules release routes both lanes: FFBox by default, the urgent lane on BEAST, else LothDesktop, development only', () => {
  const r = RELEASE_RULES;
  assert.match(r, /lothsahn, 2026-10-20: "Release builds should be handed by ffbox/);
  assert.match(r, /NORMAL, the default \("a release"/);
  assert.match(r, /No FF Factory computer builds it: no build_plan, no BEAST, no editor/);
  assert.match(r, /wake_me 40 minutes .* so no sandbox waits on FFBox/);
  assert.match(r, /URGENT, only when Ben or lothsahn says "quick" or "urgent" release/);
  assert.match(r, /priority urgent/);
  assert.match(r, /BEAST, else LothDesktop when BEAST is offline/);
  assert.match(r, /trigger-ci-release\.sh --urgent <beast\|lothdesktop>/);
  assert.match(r, /FFBox declines that bump's Release jobs and builds nothing/);
  assert.match(r, /scripts\/release\/urgent_release\.py run --version/);
  assert.match(r, /a Live view's editor is never closed or moved/);
  assert.match(r, /main goes live on development only/);
  assert.match(r, /build_plan done` at once, done or failed/);
  assert.match(r, /post the patch notes in #dev-patch-notes once live/);
  assert.match(r, /No agent changes a Steam branch or plans to\./);
  assert.doesNotMatch(r, /set(?:s|ting)? (?:it )?live on (?:pre-release|default|public)/i);
});

function world(view: boolean) {
  const ws: SessionInfo[] = [
    { id: 'builder', kind: 'worker', machineId: 'beast' } as SessionInfo,
    { id: 'viewer', kind: 'worker', machineId: 'beast' } as SessionInfo,
  ];
  const told: { id: string; text: string }[] = [];
  const deps: BuildDeps = {
    buildMachines: () => ['beast', 'lothdesktop'],
    workersOn: (id) => ws.filter((w) => w.machineId === id),
    isLive: () => true,
    isMidTurn: () => true,
    openRequestsOf: (id) => (id === 'builder' ? [{ id: 'w1639' } as WorkItem] : [{ id: 'w1468' } as WorkItem]),
    hasView: (id) => view && id === 'viewer',
    benchLock: () => undefined,
    machineOnline: () => true,
    moveTarget: () => undefined,
    move: async () => 'Moved',
    tell: (id, text) => told.push({ id, text }),
    notify: () => {},
    log: () => {},
    now: () => Date.parse('2026-10-20T21:00:00Z'),
  };
  return { plans: new BuildPlans(deps), told };
}

test('w1639: a Live view on the computer being cleared stays open; its worker is asked to hold heavy work, and told when the build is done', async () => {
  const t = world(true);
  t.plans.declare({ machine: 'beast', minutes: 0, what: 'the 1.0.0.12 urgent release', builder: 'builder', requests: ['w1639'], by: 'worker builder' });
  await t.plans.clear(t.plans.plan('beast')!);
  const p = t.plans.plan('beast')!;
  assert.deepEqual(p.kept.map((k) => k.session), ['viewer']);
  assert.deepEqual(Object.keys(p.told), [], 'the Live view worker is not asked to pause or stop its editor');
  const notice = t.told.filter((x) => x.id === 'viewer');
  assert.equal(notice.length, 1);
  assert.equal(notice[0].text, liveViewNotice(p));
  assert.match(notice[0].text, /Your Live view stays open and your editor runs: a person may be using them/);
  assert.equal(t.plans.resumeHold({ id: 'viewer', machineId: 'beast' }), undefined, 'messages to it are never held');
  t.plans.done('beast');
  assert.match(t.told.at(-1)!.text, /The build on beast is done \(w1639\): compiles, tests and builds may start again\./);
  assert.equal(t.told.at(-1)!.id, 'viewer');
});

test('w1639: without a Live view the same worker mid-turn is asked to pause as before (w1606)', async () => {
  const t = world(false);
  t.plans.declare({ machine: 'beast', minutes: 0, what: 'the 1.0.0.12 urgent release', builder: 'builder', requests: ['w1639'], by: 'worker builder' });
  await t.plans.clear(t.plans.plan('beast')!);
  assert.deepEqual(Object.keys(t.plans.plan('beast')!.told), ['viewer']);
  assert.match(t.told.find((x) => x.id === 'viewer')!.text, /Stop your sandbox's Unity editor/);
});

test('w1656: an urgent release asks A or B on one card first, and its build waits for no one', () => {
  const r = RELEASE_RULES;
  assert.match(r, /"Update your rules to ask about B when someone asks for an urgent release/);
  assert.match(r, /"Build now from the last fully green commit <sha> \(B: skips the N merges since it\)" \(recommended\)/);
  assert.match(r, /"Bump on master's tip \(A: ships N merges that only had gate tests\)"/);
  assert.match(r, /scripts\/release\/last_green\.py/);
  assert.match(r, /--from green/);
  assert.match(r, /A RELEASE BUILD WAITS FOR NO ONE/);
  assert.match(r, /pre-empt every holder/);
  assert.doesNotMatch(r, /at most 20 minutes/);
  assert.match(r, /follow it every 2 to 3 minutes with `urgent_release\.py wait --out <run> --minutes 3`/);
});

test('w1656: a normal release asks A or B too, and B in FFBox\'s lane is --from green without --urgent', () => {
  const normal = RELEASE_RULES.split('\n').find((l) => l.startsWith('- NORMAL'))!;
  assert.match(normal, /"A normal release should also provide the option of starting from the last fully green commit"/);
  assert.match(normal, /ONE CARD FIRST here too/);
  assert.match(normal, /`trigger-ci-release\.sh --from green --request <wNNN> --notes <file>` \(no --urgent\)/);
  assert.match(normal, /merged with a merge commit, as it is/);
});

test('w1668: read_rules release puts the urgent build in slot1 of its computer, and says how a builder elsewhere gets there', () => {
  // lothsahn: "Let's make sure that urgent builds always get scheduled in slot1 on whatever machine they run in so that it uses caches as warm as possible."
  assert.match(RELEASE_RULES, /THE BUILD RUNS IN THAT COMPUTER'S slot1 \(w1668/);
  assert.match(RELEASE_RULES, /a builder in another sandbox is moved into slot1 by FF Factory at build_plan start/);
  assert.match(RELEASE_RULES, /told to build where it is if slot1 cannot be emptied within 10 minutes/);
});
