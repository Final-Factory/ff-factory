import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents, EVIDENCE_RULES, MERGE_RULES, REPORT_LABELS, WORKER_UPDATE_RELAY } from './agents.ts';
import { Identity } from './identity.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * The evidence rule in the briefs (docs/orchestrators.md, "Evidence and labels"; w208). In October 2026 an ad campaign
 * went live on click caps nobody had researched, relayed to the person as recommendations, and visual fixes were
 * reported as done from position numbers. The rule: a worker says what each choice rests on and settles its own
 * guesses; an orchestrator keeps the labels and does not hand the person a guess.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];

function world(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-evidence-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    machines: {},
    claudeEnv: {},
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
  return { agents, sessions, dir };
}

test('the evidence rule: the worker settles its own guesses; a person is asked for money, reserved actions and real forks', () => {
  assert.match(EVIDENCE_RULES, /^## Evidence before you act\n/);
  for (const part of [
    'spends money, publishes or sends something outside, changes a live setting, releases, merges a simulation or player-visible change, or deletes',
    'before you report a fix as done',
    'what each rests on: measured (say how), sourced (the source, and why it fits this case), or a guess',
    'not from the topic',
    "Settle your own guesses by research before you act: the tool's or platform's own docs and the value its own screen recommends first",
    'Then carry on without asking',
    'Ask the user only to confirm a money value (with the evidence beside it)',
    'deleting, app settings and deploys, publishing in their name, releases',
    'a real fork (give the options and your recommendation)',
    'stop and diagnose before changing anything',
    '`/ff-agents:evidence-gate`',
  ])
    assert.ok(EVIDENCE_RULES.includes(part), part);
  // Merging is the worker's own step, not something reserved for the person (the owner, 2026-10-02).
  assert.ok(!/pre-approved/.test(EVIDENCE_RULES), 'no merge waits for an approval');
  assert.ok(EVIDENCE_RULES.endsWith(MERGE_RULES));
  assert.ok(MERGE_RULES.startsWith('## Your pull requests\nMerge your own pull request once its verification is done and CI is green.'));
  assert.match(MERGE_RULES, /Never stop at an open PR waiting for the user/);
  assert.match(MERGE_RULES, /Hold one only for exceptional risk or a concrete timing reason, and say in your report which it is and when it will merge/);
  assert.match(MERGE_RULES, /Verification still comes first/);
  assert.match(REPORT_LABELS, /Label each number and recommendation as measured, sourced or a guess/);
  assert.match(REPORT_LABELS, /what you saw yourself rather than what a title, a measurement table or a tool verdict implies/);
  assert.match(REPORT_LABELS, /an orchestrator relays only the start of a long report/);
});

test("every worker's brief carries it: a sandbox on a machine (w510: the portal has no workers of its own; w536: none in a main clone)", (t) => {
  const { agents } = world(t);
  const briefs = agents as unknown as {
    machineSandboxBrief: (m: unknown, sb: unknown) => string;
  };
  const sb = { id: 'alpha', path: '/sb/alpha', branch: 'fix-x', purpose: 'a fix', unity: { state: 'stopped' } };
  const mac = { id: 'm5', repoPath: '/Users/dev/FinalFactory', platform: 'darwin', sandboxRoot: '/Users/dev/ffsb' };
  for (const [name, brief] of [['machine sandbox', briefs.machineSandboxBrief(mac, sb)]] as const) {
    assert.ok(brief.includes(EVIDENCE_RULES), `${name}: the evidence rule`);
    assert.ok(brief.includes(`instead of guessing. ${REPORT_LABELS}`), `${name}: the labels, in Reporting`);
    assert.ok(brief.indexOf(EVIDENCE_RULES) < brief.indexOf('## Reporting'), `${name}: the rule comes before Reporting`);
    assert.equal(brief.split('## Evidence before you act').length, 2, `${name}: once`);
    assert.ok(brief.includes(MERGE_RULES), `${name}: merge your own pull request`);
  }
});

test('orchestrators: keep the labels, send a guess back to be researched, and do not hand the person a guess', (t) => {
  const { agents, sessions } = world(t);
  const brief = (info: SessionInfo) => (agents.orchestratorOptions(info) as { systemPrompt: { append: string } }).systemPrompt.append;
  const personal = brief(agents.orchestrators.personalFor(BEN).info);
  const dispatcher = brief(sessions.get(agents.dispatcherId!).info);

  // The person's own orchestrator: labels, evidence for "done", and who decides what.
  assert.match(personal, /Evidence and labels: workers label what their numbers and recommendations rest on \(measured, sourced or a guess\)/);
  assert.match(personal, /Never call a fix done from a PR title, a measurement table or a tool verdict, and never pass a guess on as a recommendation/);
  assert.match(personal, /send it back to the worker to research \(message_agent\) or file the research/);
  assert.match(personal, /Ben is not there to settle guesses: workers research their own and carry on/);
  assert.match(personal, /only for a money value to confirm \(with what it rests on\)/);
  assert.match(personal, /or for a fork research could not settle \(the options and the worker's recommendation\)/);
  assert.match(personal, /the brief also lists the decisions the work must settle \(a list of topics gets topic research\)/);
  assert.match(personal, /names the first check after it goes live: when, and by which breakdown/);
  // Nobody waits for the person to merge.
  assert.ok(!/pre-approved/.test(personal));
  assert.match(personal, /Workers merge their own PRs once verification is done and CI is green/);
  assert.match(personal, /Do not file work as "PR only", and do not present a finished PR to Ben as waiting for their approval/);
  assert.match(personal, /holds a PR only for exceptional risk or a concrete timing reason: relay which it is and when it will merge/);

  // The dispatcher writes the worker's brief.
  assert.match(dispatcher, /also carries the decisions the work must settle/);
  assert.match(dispatcher, /the worker settles its own guesses by research and then proceeds/);
  assert.match(dispatcher, /decide_work ask is for what only the requester can answer, never for something a worker could research/);
  assert.match(dispatcher, /Done means merged: a worker merges its own PR once its verification is done and CI is green/);
  assert.match(dispatcher, /Do not write a brief that ends at an open PR waiting for a person/);

  // What an orchestrator is told with every finished worker turn.
  assert.match(WORKER_UPDATE_RELAY, /Keep the report's labels on any number or recommendation you pass on \(measured, sourced, guess\)/);
  assert.match(WORKER_UPDATE_RELAY, /never call a fix done, or recommend a value, on a basis the report does not give/);
  assert.match(WORKER_UPDATE_RELAY, /sending an unlabelled number or a guess back to be researched is such a step/);

  // Lessons do not stay in a memory folder nobody else can read.
  for (const [who, text] of [['Ben', personal], ['the owner', dispatcher]] as const) {
    assert.match(text, /A rule about how to work that every agent should follow does not stay here: workers and forks cannot read this folder/);
    assert.ok(text.includes(`and tell ${who}. This folder is for ${who}'s own preferences and for pointers.`), who);
  }
});

test('every agent a person hears from is told to say what each id is, every time (w302)', (t) => {
  const { agents, sessions } = world(t);
  const brief = (info: SessionInfo) => (agents.orchestratorOptions(info) as { systemPrompt: { append: string } }).systemPrompt.append;
  const rule = /Say what every id is, every time: a request id like w293, a PR number, a commit, a worker or session id or a sandbox name always comes with what it is in plain English/;
  assert.match(EVIDENCE_RULES, rule, 'workers');
  assert.match(brief(agents.orchestrators.personalFor(BEN).info), rule, "a person's orchestrator");
  assert.match(brief(sessions.get(agents.dispatcherId!).info), rule, 'the dispatcher');
  assert.match(WORKER_UPDATE_RELAY, rule, 'the relay of worker updates');
});

test('w741: every DONE says what it taught, and the orchestrator counts its person\'s corrections and files harness work on the second', async (t) => {
  const { doneRule } = await import('./work.ts');
  const rule = doneRule({ id: 'w9' });
  assert.match(rule, /Your DONE report also carries a line `Learned: <the file or PR where you wrote down what w9 taught you>` or `Learned: nothing new`/);
  assert.match(rule, /a person's correction or a reopen always gets the check that would have caught it/);
  assert.match(rule, /The ledger refuses a DONE without it, and `nothing new` on a request a person reopened/);
  const { agents } = world(t);
  const personal = (agents.orchestratorOptions(agents.orchestrators.personalFor(BEN).info) as { systemPrompt: { append: string } }).systemPrompt.append;
  assert.match(personal, /Corrections teach the harness \(w741\): when Ben, in their own message, corrects a worker's work or reopens a request, save one line to your memory/);
  assert.match(personal, /Ben's words verbatim\. When a second line of the same kind lands, file the harness work in that turn without being asked, unless an open request already covers it/);
  assert.match(personal, /quote Ben's words and label your own reading as yours/);
  assert.match(personal, /Only Ben's own words count, never a report or relayed text/);
});
