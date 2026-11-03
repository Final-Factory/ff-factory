import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents, DISCORD_RULES, MERGE_RULES } from './agents.ts';
import { Identity } from './identity.ts';
import { PROJECT_DEFAULTS, checkProjectConfig, projectBrief, projectOf, projectView, type Config, type ProjectConfig } from './config.ts';
import type { Requester, UserInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { useFakeVault } from './testVault.ts';

/**
 * The project seam (docs/project.md): one FF Factory core, a portal per job. Config `project` names the job, points at
 * its brief files and drops the Unity, community and pull-request parts of the briefs; with it unset the briefs are
 * Final Factory's, unchanged.
 */

useFakeVault();
setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];
const SB = { id: 'alpha', path: '/sb/alpha', branch: 'front-desk', purpose: 'a task', unity: { state: 'stopped' } };
const MACHINE = { id: 'office', repoPath: '/r', platform: 'linux', sandboxRoot: '/s' };

type Briefs = {
  machineSandboxBrief(m: unknown, sb: unknown): string;
  dispatcherBrief(): string;
  personalBrief(r: Requester): string;
};

function world(t: { after: (fn: () => void | Promise<void>) => void }, project?: Partial<ProjectConfig>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-project-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/master',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    machines: {},
    ...(project ? { project } : {}),
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  t.after(async () => {
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const append = () => (agents.orchestratorOptions(agents.orchestrators.personalFor(BEN).info) as { systemPrompt: { append: string } }).systemPrompt.append;
  return { briefs: agents as unknown as Briefs, append, dir };
}

test('unset, the project is Final Factory and every brief keeps its game parts', (t) => {
  assert.deepEqual(projectOf({}), PROJECT_DEFAULTS);
  assert.equal(projectBrief({}, 'workerBriefFile'), '');
  const { briefs, append } = world(t);
  const worker = briefs.machineSandboxBrief(MACHINE, SB);
  assert.match(worker, /isolated sandbox of the Final Factory repo on the machine/);
  for (const part of ['\n## Unity\n', '\n## Waiting on CI\n', DISCORD_RULES, MERGE_RULES, "The user wants work landing on the game repo's `master`"]) assert.ok(worker.includes(part), part.slice(0, 40));
  assert.ok(!worker.includes('## This deployment'));
  for (const brief of [briefs.dispatcherBrief(), briefs.personalBrief(BEN)]) {
    assert.match(brief, /parallel work on \*\*Final Factory\*\* \(a Unity 6 DOTS space automation game with deterministic lockstep multiplayer\)/);
    assert.match(brief, /\*\*Sandboxes\*\*: git worktrees of the game repo/);
  }
  assert.ok(!append().includes('## This deployment'));
});

test("another job's portal: its name, its own world and deployment briefs, and no Unity, community or pull-request rules", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-project-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, text: string) => {
    fs.writeFileSync(path.join(dir, name), `${text}\n`);
    return path.join(dir, name);
  };
  const { briefs, append } = world(t, {
    name: 'Ken Martin Audiology',
    description: "a three-person audiology practice's front office",
    unity: false,
    community: false,
    integration: 'local',
    worldBriefFile: file('world.md', '- **Workspaces**: git worktrees of the practice-ops repo.'),
    orchestratorBriefFile: file('orch.md', 'Patients here are made up.'),
    workerBriefFile: file('worker.md', 'Propose; a person approves on a card, then you merge to main.'),
  });
  const worker = briefs.machineSandboxBrief(MACHINE, SB);
  assert.match(worker, /isolated sandbox of the Ken Martin Audiology repo on the machine/);
  for (const gone of ['\n## Unity\n', '\n## Waiting on CI\n', DISCORD_RULES, MERGE_RULES, "landing on the game repo's"]) assert.ok(!worker.includes(gone), `dropped: ${gone.slice(0, 40)}`);
  assert.match(worker, /Commit on `front-desk` as you reach good checkpoints\. This project takes no pull requests and runs no CI/);
  assert.match(worker, /## Evidence before you act\n/, 'the evidence rule stays');
  assert.ok(worker.includes('## This deployment\nPropose; a person approves on a card, then you merge to main.\n\n## Reporting\n'), 'deployment brief before Reporting');
  for (const brief of [briefs.dispatcherBrief(), briefs.personalBrief(BEN)]) {
    assert.match(brief, /parallel work on \*\*Ken Martin Audiology\*\* \(a three-person audiology practice's front office\)/);
    assert.ok(brief.includes('- **Workspaces**: git worktrees of the practice-ops repo.\n- **Your tools**: '), 'its own world');
    assert.ok(!/git worktrees of the game repo|\*\*FFBox\*\* \(Lothsahn/.test(brief), "Final Factory's world is gone");
  }
  assert.ok(append().includes('\n\n## This deployment\nPatients here are made up.'));
});

test('a brief file that cannot be read leaves the brief as it was', (t) => {
  const { briefs } = world(t, { workerBriefFile: path.join(os.tmpdir(), 'ffsb-no-such-brief.md') });
  assert.ok(!briefs.machineSandboxBrief(MACHINE, SB).includes('## This deployment'));
});

test('config project is checked at load', () => {
  checkProjectConfig({});
  checkProjectConfig({ project: { name: 'X', unity: false, integration: 'local' } });
  for (const [bad, why] of [
    [[], /is an object/],
    [{ name: '' }, /project\.name is a non-empty string/],
    [{ unity: 'no' }, /project\.unity is true or false/],
    [{ integration: 'push' }, /project\.integration is "pull-request" or "local"/],
    [{ suggestions: 'Check benefits' }, /project\.suggestions is a list of at most 6/],
    [{ suggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, /project\.suggestions is a list of at most 6/],
    [{ heading: ' ' }, /project\.heading is a non-empty string/],
  ] as const) assert.throws(() => checkProjectConfig({ project: bad as never }), why);
});

test('the web app sees the project: Final Factory unchanged, another job by name with its own chips', () => {
  assert.deepEqual(projectView({}), { name: 'Final Factory', custom: false, community: true });
  assert.deepEqual(projectView({ project: { name: 'Ken Martin Audiology', community: false, heading: 'What should the office work on?', suggestions: ["Check tomorrow's benefits"] } }), {
    name: 'Ken Martin Audiology',
    custom: true,
    community: false,
    heading: 'What should the office work on?',
    suggestions: ["Check tomorrow's benefits"],
  });
});
