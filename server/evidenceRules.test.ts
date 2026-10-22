import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents, BRIEF_NOW_ONLY, EVIDENCE_RULES, MERGE_RULES, REPORT_LABELS, WORKER_UPDATE_RELAY } from './agents.ts';
import { Identity } from './identity.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { useFakeVault } from './testVault.ts';

// Every Claude process runs on a vault token (w1078): these tests start orchestrators, workers or standing agents.
useFakeVault();

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

/**
 * The rules a worker's prompt leaves to the game repo's CLAUDE.md (w1482: each said once; every worker runs in a game
 * sandbox, so CLAUDE.md is in every worker's context). The prompt names each by its heading; the game repo's
 * scripts/tests/test_claude_md_worker_rules.py checks that CLAUDE.md still holds them.
 */
const CLAUDE_MD_RULES = ['"Evidence before action"', '"Merge your own PR"', '"Discord: FFBox owns #bug-reports"', '"Before every DONE"', '"`master` is the one trunk"', '"Unfinished content goes behind a feature toggle"'];

test('the evidence rule: the worker settles its own guesses; a person is asked for money, reserved actions and real forks', () => {
  assert.match(EVIDENCE_RULES, /^## Evidence before you act\n/);
  for (const part of [
    `CLAUDE.md's "Evidence before action" binds you`,
    'not from the topic',
    "settle your own guesses by research (the tool's or platform's own docs and the value its own screen recommends first",
    'then carry on without asking',
    'say how it could fail and look early',
    '`/ff-agents:evidence-gate`',
  ])
    assert.ok(EVIDENCE_RULES.includes(part), part);
  // Merging is the worker's own step, not something reserved for the person.
  assert.ok(!/pre-approved/.test(EVIDENCE_RULES), 'no merge waits for an approval');
  assert.ok(EVIDENCE_RULES.endsWith(MERGE_RULES));
  assert.ok(MERGE_RULES.startsWith(`## Your pull requests\nCLAUDE.md's "Merge your own PR" holds in every repo you work in`));
  assert.match(MERGE_RULES, /merge your own once its verification is done and CI is green/);
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
    // The game repo's trunk: a PR into master the worker merges; the trunk rules themselves are CLAUDE.md's.
    assert.match(brief, /ff-pr push --base master/, `${name}: ff-pr opens the PR into master`);
    assert.match(brief, /git fetch origin && git merge origin\/master/, `${name}: merge origin/master, never rebase a pushed branch`);
    assert.match(brief, /gh pr create --base master.*gh pr merge <n> --merge/, `${name}: open a PR into master, merge it`);
    assert.match(brief, /Never force-push anywhere/, `${name}: never force-push`);
    assert.ok(!/origin\/develop|HEAD:develop|rebase origin/.test(brief), `${name}: no develop flow left`);
    for (const rule of CLAUDE_MD_RULES.filter((r) => r !== '"Before every DONE"')) assert.ok(brief.includes(`CLAUDE.md's ${rule}`) || brief.includes(`and ${rule}`), `${name}: points at CLAUDE.md's ${rule}`);
    // Said once: the rules CLAUDE.md holds are not restated here.
    assert.ok(!/Hold one only for exceptional risk/.test(brief), `${name}: the hold rule is CLAUDE.md's`);
    assert.ok(!/belong to FFBox: read their threads/.test(brief), `${name}: FFBox's channels are CLAUDE.md's`);
    assert.ok(!/a person's correction or a reopen always gets the check/.test(brief), `${name}: what needs a Learned line is CLAUDE.md's`);
  }
});

test("w1482: a worker's brief speaks of now: no request-id provenance, no quoted past corrections, no dates of rule changes", (t) => {
  const { agents } = world(t);
  const briefs = agents as unknown as { machineSandboxBrief: (m: unknown, sb: unknown) => string };
  const sb = { id: 'alpha', path: '/sb/alpha', branch: 'fix-x', purpose: 'a fix', unity: { state: 'stopped' } };
  for (const platform of ['darwin', 'win32', 'linux']) {
    const brief = briefs.machineSandboxBrief({ id: 'm5', repoPath: '/r', platform, sandboxRoot: '/s' }, sb);
    // Ids left in are examples of a format ("w513: ...", "after w727's PR #1291 merges", "w293 (...)"), plus the w1480 pilot's heading.
    const ids = (brief.match(/\bw\d{3,4}\b/g) ?? []).filter((id) => !['w513', 'w727', 'w293', 'w1480'].includes(id));
    assert.deepEqual(ids, [], `${platform}: request ids as provenance`);
    assert.ok(!/\b20\d\d-\d\d-\d\d\b/.test(brief.replace('UserData layout of 2026-10-11', '')), `${platform}: no dates of rule changes`);
    assert.ok(!/\((?:Ben|lothsahn|Lothsahn), 20\d\d/.test(brief), `${platform}: no quoted corrections`);
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
  // w1288: "can't" from the orchestrator's own toolset is filed work, not an answer (w935 Unity, w1287 Claude Design).
  assert.match(personal, /Never tell Ben "I can't" or "you can do it yourself" from your own toolset/);
  assert.match(personal, /request_work for a worker to research the route .* and try it/);
  assert.match(personal, /the smallest step only they can take \(their own login, password or 2FA code, an approval\)/);
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

test("w1770: what players run is checked by running it, in every worker's brief and the person's orchestrator's", (t) => {
  const { agents } = world(t);
  // Workers: the claim rests on a run of that build or its exact commit; git or a grep is a guess naming the build.
  assert.match(EVIDENCE_RULES, /a claim that a feature or fix is, or isn't, in a build players run \(a Steam branch, a build number\) rests on running that build, or a build of its exact commit, and opening the feature/);
  assert.match(EVIDENCE_RULES, /from a grep, git or a past report it is a guess that names the build to run/);
  assert.match(EVIDENCE_RULES, /Asked to investigate, settle any doubt your quick look leaves with that run/);
  assert.match(EVIDENCE_RULES, /A DONE for a player-facing fix names the Steam branch and build that carry it \(`Ships in:`\) and whether pre-1\.0 needs a cherry-pick \(`pre-1\.0:`\)/);
  // The person's orchestrator: investigate when asked, file the reproduce work in the same turn, never answer from a grep.
  const personal = (agents.orchestratorOptions(agents.orchestrators.personalFor(BEN).info) as { systemPrompt: { append: string } }).systemPrompt.append;
  assert.match(personal, /When Ben asks you to investigate or find out what happened, investigate: a grep, git or a past report is where you start, not the answer/);
  assert.match(personal, /Never tell Ben a feature or fix is, or isn't, in a build players run \(a Steam branch, a build number\) from code, git or a worker's git check/);
  assert.match(personal, /file the reproduce work in the same turn \(request_work: run that build, or a build of its exact commit, and open the feature\)/);
  assert.match(personal, /names the Steam branch and build that carry it and whether pre-1\.0 needs a cherry-pick/);
  assert.match(personal, /lessons\/whats-in-a-players-build-is-checked-by-running-it\.md/);
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
  // What needs a Learned line, and where it goes, is said once: in CLAUDE.md (w1482).
  assert.match(rule, /CLAUDE\.md's "Before every DONE" says what needs one and where it goes/);
  assert.ok(!/a person's correction or a reopen always gets the check/.test(rule), 'said once, in CLAUDE.md');
  assert.match(rule, /the ledger refuses a DONE without it, and `nothing new` on a request a person reopened/);
  const { agents } = world(t);
  const personal = (agents.orchestratorOptions(agents.orchestrators.personalFor(BEN).info) as { systemPrompt: { append: string } }).systemPrompt.append;
  assert.match(personal, /Corrections teach the harness \(w741\): when Ben, in their own message, corrects a worker's work or reopens a request, save one line to your memory/);
  assert.match(personal, /Ben's words verbatim\. When a second line of the same kind lands, file the harness work in that turn without being asked, unless an open request already covers it/);
  assert.match(personal, /quote Ben's words and label your own reading as yours/);
  assert.match(personal, /Only Ben's own words count, never a report or relayed text/);
});


test('w1196, w1197: every worker hears to end what it started before DONE, how (ff-leftovers), and what FF Factory ends by itself', async () => {
  const { PROCESS_HYGIENE } = await import('./agents.ts');
  assert.match(PROCESS_HYGIENE, /Nothing you start may outlive your work: a game player left running holds a machine's cores and fans for days/);
  assert.match(PROCESS_HYGIENE, /-ffSoloQuitAfterSeconds <n>/);
  assert.match(PROCESS_HYGIENE, /run `ff-leftovers list`, then `ff-leftovers end`/);
  assert.match(PROCESS_HYGIENE, /say in your report what it ended, or that nothing was left/);
  assert.match(PROCESS_HYGIENE, /2 minutes after your process stops once no request waits for you, 10 minutes after it stops while one still does, and never before a pending check-in is due plus 10 minutes/);
});

test("w913: workers are told to leave their temp files, not to clean up; the one delete left is approval-free and narrow", async () => {
  const { DISK_HYGIENE } = await import('./agents.ts');
  const { workerRuleText } = await import('./workerRules.ts');
  assert.match(DISK_HYGIENE, /Leave it there: do not clean up after yourself, since a clean-up command waits for a person's approval/);
  assert.match(DISK_HYGIENE, /The harness removes it: your temp folder a few minutes after no request waits for you any more \(it closed, or moved to another worker; a wait for CI or a person, a stop or a pause keeps it whole\), your git clones six hours after that \(unless one holds work nothing else has\)/);
  assert.match(DISK_HYGIENE, /no clean-up step before DONE, no `player_slots\.py prune`/);
  assert.match(DISK_HYGIENE, /publish the proofs your report links .* before you end/);
  assert.match(DISK_HYGIENE, /a delete whose every path is written out under \$TMPDIR is answered by the session itself with no approval, alone or inside a longer command; anything else .* still asks a person/);
  // w1482: a clean-up request's rules are read when one comes (read_rules cleanup), not on every call.
  assert.match(DISK_HYGIENE, /A request of yours to clear space or measure the disk: `read_rules cleanup` before you delete anything/);
  const cleanup = workerRuleText('cleanup');
  // w1379: a clean-up is judged by the ledger, not by a list in its brief.
  assert.match(cleanup, /run `ff-leftovers folders` and delete only its DELETE rows/);
  assert.match(cleanup, /open, stalled or paused are KEEP rows whether or not its process runs/);
  // w1387: and by git: a clone with work on no remote keeps its folder, and the portal's clean-up log says so too.
  assert.match(cleanup, /A folder holding a git clone with uncommitted changes, unpushed commits or a stash is KEEP too, whatever the ledger says/);
  assert.match(cleanup, /check its git state .* or the portal's clean-up log \(`portal_logs` source cleanup: "kept for a person"\)/);
  // A save copy is named so the session can delete it alone (server/tempDelete.ts).
  assert.match(workerRuleText('saves'), /under your temp folder's name \(`ffa-<session>-<id>-<name>\.zip`\)/);
  // The old instructions are gone.
  for (const text of [DISK_HYGIENE, cleanup]) {
    assert.ok(!/Before you report a request done, clean up after yourself/.test(text));
    assert.ok(!/delete the player builds, Captures/.test(text));
    assert.ok(!/and you may remove them too, without asking/.test(text));
  }
});

test("w1097: every worker's brief says which shell step still waits for a person, and the routes that never do", async (t) => {
  const { DISK_HYGIENE, SHELL_STEPS } = await import('./agents.ts');
  const { workerRuleText } = await import('./workerRules.ts');
  // Why w1079 deleted its own temp: to reuse a test's output folder. The brief says to make a new one.
  assert.match(DISK_HYGIENE, /never delete in your temp folder to reuse a folder for the next test leg; give every leg a new one, `\$TMPDIR\/<leg>-<timestamp>`/);
  // w1479: said once, in Disk space; Shell steps points there.
  assert.match(SHELL_STEPS, /Deletes in \$TMPDIR: Disk space above/);
  assert.match(SHELL_STEPS, /^## Shell steps that never wait for a person\n/);
  assert.match(SHELL_STEPS, /except when Claude Code's own dangerous-rm check flags a delete in it/);
  assert.match(SHELL_STEPS, /in a script file in \$TMPDIR, written with the Write tool, and run it: `bash "\$TMPDIR\/leg\.sh" 1920`/);
  assert.match(SHELL_STEPS, /The game's settings and saves around a test: `read_rules saves`/);
  const saves = workerRuleText('saves');
  assert.match(saves, /`python scripts\/game_data\.py` \(`snapshot`, `restore`, `run --name <leg> -- <command>`/);
  assert.match(saves, /writes only the game's two settings files and the saves you name/);
  assert.match(saves, /GameDataPaths\.Saves` = `<data root>\/UserData\/saves\/`/);
  const { agents } = world(t);
  const brief = (agents as unknown as { machineSandboxBrief: (m: unknown, sb: unknown) => string }).machineSandboxBrief(
    { id: 'm5', repoPath: '/Users/dev/FinalFactory', platform: 'darwin', sandboxRoot: '/Users/dev/ffsb' },
    { id: 'alpha', path: '/sb/alpha', branch: 'fix-x', purpose: 'a fix', unity: { state: 'stopped' } },
  );
  assert.ok(brief.includes(SHELL_STEPS) && brief.indexOf(DISK_HYGIENE) < brief.indexOf(SHELL_STEPS) && brief.indexOf(SHELL_STEPS) < brief.indexOf('## Reporting'));
  assert.match(brief, /A save to load in the game \(an attached one or your own\): `read_rules saves` first/);
});

test("w896: clean-up deletes only inside the worker install folder, in every worker's brief, the dispatcher's and the orchestrators' instructions", async (t) => {
  const { DISK_HYGIENE } = await import('./agents.ts');
  const { workerRuleText } = await import('./workerRules.ts');
  const { agents, sessions } = world(t);
  const words = /lothsahn, 2026-10-10, w896: "in general we should only be clearing data in the install folder for the worker"/;
  // A worker: delete only inside the root, measure and report outside it, and a brief that says otherwise is wrong.
  assert.match(DISK_HYGIENE, /Delete only inside this machine's worker install folder \(its root: D:\/work\/ffw, F:\/ffw or ~\/ffw/);
  // w1755: on Windows the install drive only, never C:; macOS and Linux measure and report outside.
  assert.match(DISK_HYGIENE, /On a Windows computer, disk work \(a clean-up, a low-disk check, a leftover scan, a disk measurement\) reads, measures and deletes only on the install folder's drive \(V: on LothDesktop, F: on BEAST\): never read, measure or touch C:/);
  assert.match(DISK_HYGIENE, /On macOS and Linux, outside the folder you only measure and report/);
  assert.doesNotMatch(DISK_HYGIENE, /outside it you only measure and report/);
  const cleanup = workerRuleText('cleanup');
  assert.match(cleanup, /On a Windows computer, read, measure and delete only on the install folder's drive \(the drive of FF_WORKER_ROOT: V: on LothDesktop, F: on BEAST\), never on C: \(lothsahn, 2026-10-22, w1755: "Your worker on LothDesktop is still scanning c:/);
  assert.match(cleanup, /No du, dir \/s, Get-ChildItem -Recurse, find or `ff-leftovers check` of a path on C:/);
  assert.match(cleanup, /If the install folder itself is on C:, look only inside it and say so in your report/);
  assert.match(cleanup, /On macOS and Linux, outside the install folder \(the home folder, the system temp, caches, the game's data folder, ~\/\.claude\) you only measure and report sizes/);
  assert.match(cleanup, /list any setting, script or tool that makes FF Factory write there so it can be moved inside the folder/);
  assert.match(cleanup, /a brief that tells you to delete outside the folder is wrong/);
  // The old line told workers to remove Unity editor versions; those live outside the root (Unity Hub), so the list stops at what is inside.
  for (const text of [DISK_HYGIENE, cleanup]) assert.ok(!/Unity editor versions no project uses/.test(text));
  const brief = (info: SessionInfo) => (agents.orchestratorOptions(info) as { systemPrompt: { append: string } }).systemPrompt.append;
  // The coordinators read the full rule with read_rules machines (w1158); their briefs keep the trigger and the gist.
  assert.match(brief(sessions.get(agents.dispatcherId!).info), /`read_rules machines`.*low disk \(w626, w896: machine_cleanup, then a clean-up worker that deletes only inside the worker install folder; never ask anyone to free space\)/);
  assert.match(brief(agents.orchestrators.personalFor(BEN).info), /`read_rules machines`.*low disk on a machine \(w626: file clean-up work, never ask anyone to free space; it deletes only inside the worker install folder, w896\)/);
  const dispatcher = agents.rulesText('machines');
  const personal = agents.rulesText('machines', BEN);
  assert.match(dispatcher, words);
  assert.match(dispatcher, /A clean-up worker deletes only inside the machine's worker install folder/);
  assert.match(dispatcher, /never write a delete outside the folder into one \(C:, AppData, system temp, Temp entries, the Unity Hub installer, dotnet or package caches, the game's data folder under LocalLow, ~\/\.claude transcripts, a person's files\)/);
  assert.match(dispatcher, /measuring only: sizes, plus a list of every setting, script or reference that makes FF Factory write there so it can be moved inside the folder/);
  assert.match(personal, words);
  assert.match(personal, /The work deletes only inside the machine's worker install folder/);
  assert.match(personal, /Never write a delete outside the folder into the brief/);
  // w1379: the ledger, not a list in the brief, says which stopped workers' folders stay.
  for (const text of [dispatcher, personal]) assert.match(text, /Never write a list of live or "will resume" workers into a clean-up brief.*`ff-leftovers folders` and delete only its DELETE rows/);
});

test("w1478: a sandbox worker's brief names its Unity instance and carries the fewer-calls rules", async (t) => {
  const { FEWER_CALLS, SHELL_STEPS } = await import('./agents.ts');
  const { unityInstanceName } = await import('../shared/unityInstance.ts');
  const { agents } = world(t);
  const brief = (agents as unknown as { machineSandboxBrief: (m: unknown, sb: unknown) => string }).machineSandboxBrief(
    { id: 'm5', repoPath: '/Users/dev/FinalFactory', platform: 'darwin', sandboxRoot: '/Users/dev/ffsb' },
    { id: 'alpha', path: '/Users/dev/ffsb/alpha', branch: 'fix-x', purpose: 'a fix', unity: { state: 'stopped' } },
  );
  assert.ok(brief.includes(`Your editor's MCP instance is \`${unityInstanceName('/Users/dev/ffsb/alpha')}\``));
  assert.ok(brief.includes(FEWER_CALLS) && brief.indexOf(SHELL_STEPS) < brief.indexOf(FEWER_CALLS) && brief.indexOf(FEWER_CALLS) < brief.indexOf('## Reporting'));
  assert.match(FEWER_CALLS, /^## Fewer model calls\n/);
  assert.match(FEWER_CALLS, /parallel tool calls/);
  // The built-in Explore is hidden from workers (w1482): the plugin's own does broad sweeps.
  assert.match(FEWER_CALLS, /five or more reads .* `ff-agents:Explore` or `ff-agents:scout` subagent/);
  assert.match(FEWER_CALLS, /until <done>; do sleep 20; done/);
  assert.match(FEWER_CALLS, /`get_test_job` with `wait_timeout`/);
  // The section must stay short: it is re-read on every call of every worker (w1469's base trim).
  assert.ok(FEWER_CALLS.split(/\s+/).length < 230, `FEWER_CALLS is ${FEWER_CALLS.split(/\s+/).length} words`);
  // w1482: the rare Unity rules are read when needed.
  assert.match(brief, /`read_rules unity` before your first one, when a start is refused for a batch build, or at a fresh sandbox's first boot/);
  assert.match((await import('./workerRules.ts')).workerRuleText('unity'), /`mcp__machine__unity` action `clear_batch`/);
});

test('w1482: a worker reads its rare rules with read_rules, and the topics the prompt names are the tool\'s', async (t) => {
  const { WORKER_RULE_TOPICS, workerRuleText } = await import('./workerRules.ts');
  const { agents } = world(t);
  const brief = (agents as unknown as { machineSandboxBrief: (m: unknown, sb: unknown) => string }).machineSandboxBrief(
    { id: 'm5', repoPath: '/r', platform: 'darwin', sandboxRoot: '/s' },
    { id: 'alpha', path: '/s/alpha', branch: 'fix-x', purpose: 'a fix', unity: { state: 'stopped' } },
  );
  assert.match(brief, /Rules few tasks need are in `mcp__machine__read_rules` \(`read_rules <topic>`\)/);
  const named = [...brief.matchAll(/`read_rules (\w+)`/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(named)].sort(), [...WORKER_RULE_TOPICS].sort(), 'every topic is named in the prompt, and only topics that exist');
  for (const topic of WORKER_RULE_TOPICS) assert.ok(workerRuleText(topic).length > 200, topic);
  assert.match(workerRuleText('nope'), /No topic "nope"\. The topics: cleanup, saves, unity\./);
});

test('w1482: the dispatcher and every orchestrator write briefs that speak of now, not of how the rules came to be', (t) => {
  const { agents, sessions } = world(t);
  const brief = (info: SessionInfo) => (agents.orchestratorOptions(info) as { systemPrompt: { append: string } }).systemPrompt.append;
  for (const [who, text] of [['dispatcher', brief(sessions.get(agents.dispatcherId!).info)], ["Ben's orchestrator", brief(agents.orchestrators.personalFor(BEN).info)]] as const) {
    assert.ok(text.includes(BRIEF_NOW_ONLY), who);
    assert.ok(!text.includes('${BRIEF_NOW_ONLY}'), `${who}: the rule is filled in`);
  }
  assert.match(BRIEF_NOW_ONLY, /no provenance ids, quoted past corrections, "was X, now Y" or dates of rule changes unless the worker needs one to act/);
  assert.match(BRIEF_NOW_ONLY, /The harness adds the request as filed unless your brief quotes it/);
});
