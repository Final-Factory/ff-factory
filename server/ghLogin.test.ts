// w1463: each machine's gh login and its token's scopes, names only (shared/ghLogin.ts, machine/ghLogin.ts), and what placement
// does with them (server/placement.ts). A push of a .github/workflows file was refused four times for a machine's gh token
// without the `workflow` scope; these fail if the scopes stop being read, the brief stops saying it, placement stops preferring
// a machine that can push such a file, or a token's value could reach a report, a line or a log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { canPushWorkflows, changesWorkflows, ghBriefLine, ghLoginLabel, ghMachineLine, parseGhStatusJson, parseGhStatusText, sanitizeGhLogin, scopeList, type GhLogin } from '../shared/ghLogin.ts';
import { GhLoginWatch, READ_EVERY_MS, ghHostsFile, readGhLogin } from '../machine/ghLogin.ts';
import { capacityLines, pickComputer, placementHint, workflowLine, type Computer } from './placement.ts';
import type { RunResult } from './proc.ts';

const NOW = new Date('2026-10-18T12:00:00Z');
// Made-up values in the shape of real ones (never a real token): what must never come out the other side.
const OAUTH = 'gho_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const PAT = 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
const TOKENS = [OAUTH, PAT, OAUTH.slice(4), PAT.slice(11)];

/** What `gh auth status --active --hostname github.com --json hosts` printed on BEAST (measured 2026-10-18, gh 2.102.0). */
const BEAST_JSON = '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"bryding","tokenSource":"keyring","scopes":"gist, read:org, repo","gitProtocol":"https"}]}}';
/** The same login's text form, with the token line as `--show-token` would print it: the parser must never carry it on. */
const BEAST_TEXT = `github.com
  ✓ Logged in to github.com account bryding (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: ${OAUTH}
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
`;

const noToken = (what: string, text: string) => {
  for (const t of TOKENS) assert.ok(!text.includes(t), `${what} carries a token value: ${text}`);
  assert.doesNotMatch(text, /gh[pousr]_[A-Za-z0-9]{8}|github_pat_[A-Za-z0-9]/, `${what} carries something token-shaped`);
};

test('w1463: gh auth status JSON gives the account and scope names; BEAST measured without the workflow scope', () => {
  const gh = parseGhStatusJson(BEAST_JSON, NOW)!;
  assert.deepEqual(gh, { checkedAt: NOW.toISOString(), ok: true, account: 'bryding', scopes: ['gist', 'read:org', 'repo'], source: 'keyring' });
  assert.equal(canPushWorkflows(gh), false);
  assert.equal(ghMachineLine(gh), 'gh: bryding (gist, read:org, repo; cannot push .github/workflows (no workflow scope))');
  const m3 = parseGhStatusJson(BEAST_JSON.replace('"gist, read:org, repo"', '"admin:org, repo, workflow"'), NOW)!;
  assert.equal(canPushWorkflows(m3), true);
  assert.equal(ghMachineLine(m3), 'gh: bryding (admin:org, repo, workflow; can push .github/workflows)');
  // Several accounts: the active one. A failed one says why, with no account to act as.
  const two = '{"hosts":{"github.com":[{"state":"success","active":false,"login":"other","scopes":"repo, workflow"},{"state":"success","active":true,"login":"bryding","scopes":"repo"}]}}';
  assert.equal(parseGhStatusJson(two, NOW)!.account, 'bryding');
  assert.equal(parseGhStatusJson('{"hosts":{"github.com":[{"state":"error","active":true,"login":"bryding","scopes":""}]}}', NOW)!.ok, false);
  assert.equal(parseGhStatusJson('{"hosts":{}}', NOW)!.error, 'gh is not logged in to github.com');
  assert.equal(parseGhStatusJson('unknown flag: --json', NOW), undefined, 'not JSON: the caller reads the text form');
  // A fine-grained login reports no scopes: whether it may push a workflow file is unknown, not "no".
  const fine = parseGhStatusJson(BEAST_JSON.replace('"gist, read:org, repo"', '""'), NOW)!;
  assert.deepEqual(fine.scopes, []);
  assert.equal(canPushWorkflows(fine), undefined);
  assert.match(ghLoginLabel(fine), /no scopes reported: a fine-grained token/);
});

test('w1463: the text form (a gh without --json), old and new wording, never keeps the Token line', () => {
  const gh = parseGhStatusText(BEAST_TEXT, NOW);
  assert.deepEqual(gh, { checkedAt: NOW.toISOString(), ok: true, account: 'bryding', scopes: ['gist', 'read:org', 'repo', 'workflow'], source: 'keyring' });
  noToken('the parsed text form', JSON.stringify(gh));
  const old = parseGhStatusText(`github.com\n  ✓ Logged in to github.com as bryding (oauth_token)\n  ✓ Git operations for github.com configured to use https protocol.\n  ✓ Token: ${OAUTH}\n  ✓ Token scopes: gist, read:org, repo\n`, NOW);
  assert.deepEqual([old.account, old.scopes, old.source], ['bryding', ['gist', 'read:org', 'repo'], 'oauth_token']);
  const out = parseGhStatusText('You are not logged into any GitHub hosts. To log in, run: gh auth login\n', NOW);
  assert.deepEqual([out.ok, out.error], [false, 'gh is not logged in to github.com']);
  assert.deepEqual(scopeList("'repo', 'workflow', 'repo'"), ['repo', 'workflow']);
});

test('w1463: whatever a daemon sends, the portal keeps names only: no token in an account, a scope, a source or an error', () => {
  const kept = sanitizeGhLogin({ checkedAt: NOW.toISOString(), ok: true, account: OAUTH, scopes: ['repo', PAT, 'workflow', 7], source: `/home/x/.config/gh/${OAUTH}`, token: OAUTH, extra: PAT })!;
  noToken('a sanitized report', JSON.stringify(kept));
  assert.deepEqual(kept, { checkedAt: NOW.toISOString(), ok: false, scopes: ['repo', 'workflow'], error: 'no account reported' });
  const err = sanitizeGhLogin({ checkedAt: NOW.toISOString(), ok: false, error: `gh said: bad token ${OAUTH} and ${PAT}` })!;
  noToken('a sanitized error', JSON.stringify(err));
  assert.equal(sanitizeGhLogin({ ok: true, account: 'bryding' }), undefined, 'no time: not a report');
  assert.equal(sanitizeGhLogin('bryding'), undefined);
});

test('w1463: the worker brief line says whether this machine may push .github/workflows, and where to hand the push', () => {
  const no = parseGhStatusJson(BEAST_JSON, NOW)!;
  const yes = { ...no, scopes: ['repo', 'workflow'] };
  const beast = ghBriefLine('beast', no, undefined, ['m3', 'beast']);
  assert.equal(
    beast,
    "- GitHub token: this machine's gh token: bryding (gist, read:org, repo): it cannot push .github/workflows (GitHub refuses a workflow file without the `workflow` scope); such a change must be pushed from a machine that can (m3: list_machines shows each machine's gh); commit the rest, push without the workflow file, and hand that step to your orchestrator. Never print a token.",
  );
  assert.equal(ghBriefLine('m3', yes, undefined, ['m3']), "- GitHub token: this machine's gh token: bryding (repo, workflow): it can push changes to .github/workflows.");
  assert.match(ghBriefLine('pc', undefined, undefined, []), /not reported yet \(a daemon from before w1463\): whether it can push \.github\/workflows is unknown/);
  assert.match(ghBriefLine('beast', no, undefined, []), /none reports the workflow scope now/);
  // A vault GitHub token (w1031, docs/vault.md 13) takes the machine login's place: the line names it by name and last four.
  const vault = ghBriefLine('beast', no, 'vault-ben-github …abcd', ['m3']);
  assert.match(vault, /^- GitHub token: this run's gh and git push use vault-ben-github …abcd from the vault, not this machine's login \(bryding \(gist, read:org, repo\)\)\. A vault GitHub token is fine-grained: Workflows \(read and write\) is required of it/);
  for (const line of [beast, vault]) noToken('the brief line', line);
});

test('w1463: which requests change .github/workflows, from their own words', () => {
  for (const yes of [
    'CI: run the scripts/hooks Python tests in main.yml (needs a token with workflow scope)', // w1452's title
    'Add a step to .github/workflows/main.yml',
    'edit .github\\workflows\\ci.yml',
    'Change the CI workflow so the e2e job skips docs',
    'the master-batch.yml job should bisect',
    'Add a job to windows.yml for the new test',
    'This needs the workflows permission',
  ])
    assert.equal(changesWorkflows(yes), true, yes);
  for (const no of [
    'Read CI with gh run list and merge on green',
    'Fix the dispatcher workflow for queued requests',
    'w1459: LifeAsTwoMegaWave live-load test fails on master',
    'Update docs/ci.md with the new job names',
    'ProjectSettings.yaml is wrong after the upgrade',
    '',
  ])
    assert.equal(changesWorkflows(no), false, no);
});

/** A computer with room for work that needs no editor; `gh` true/false/undefined is its login's workflow scope. */
const pc = (id: string, workflows?: boolean, extra: Partial<Computer> = {}): Computer => ({
  id,
  online: true,
  live: 1,
  midTurn: 1,
  maxAgents: 6,
  sandboxes: 3,
  maxSandboxes: 4,
  freeSandboxes: 1,
  agentSeats: 4,
  ...(workflows !== undefined ? { workflows, gh: `bryding (${workflows ? 'repo, workflow' : 'gist, read:org, repo'})` } : {}),
  ...extra,
});

test('w1463: placement puts work that changes .github/workflows on a computer whose gh may push it, and says why', () => {
  const places = [pc('beast', false, { live: 0, midTurn: 0 }), pc('lothdesktop', undefined, { live: 0, midTurn: 0 }), pc('m3', true, { live: 4, midTurn: 4 })];
  // Without the workflow need, the emptiest wins (beast); with it, m3, the only one that can push such a file.
  assert.equal(pickComputer(places, undefined, {}, 'agent')!.pick.id, 'beast');
  const p = pickComputer(places, undefined, {}, 'agent', true)!;
  assert.equal(p.pick.id, 'm3');
  assert.match(p.why, /^its gh token may push \.github\/workflows \(w1463\); the only one with room/);
  // The able one busy or held: the work still goes somewhere, and the why says its push must go from elsewhere.
  const busy = [places[0], places[1], pc('m3', true, { midTurn: 6, live: 6 })];
  assert.match(pickComputer(busy, undefined, {}, 'agent', true)!.why, /^every computer whose gh may push \.github\/workflows \(m3\) is busy or held, so its workflow push must go from elsewhere/);
  assert.match(pickComputer(places, undefined, { hold: { m3: 'Ben testing' } }, 'agent', true)!.why, /\(m3\) is busy or held/);
  assert.match(pickComputer([places[0]], undefined, {}, 'agent', true)!.why, /^no computer reports a gh token with the workflow scope/);

  // The note at start_agent: placed on beast, it says beast's token lacks the scope and m3 has it, even though beast is the
  // emptiest (the plain note would say nothing).
  assert.equal(placementHint('beast', places, undefined, {}, undefined, 'agent'), undefined);
  const note = placementHint('beast', places, undefined, {}, undefined, 'agent', true)!;
  assert.match(note, /^ Note: this work changes \.github\/workflows, and beast's gh token \(bryding \(gist, read:org, repo\)\) lacks the workflow scope, so GitHub will refuse its push of a workflow file; m3's gh may push it \(bryding \(repo, workflow\); its gh token may push/);
  assert.match(placementHint('lothdesktop', places, undefined, {}, undefined, 'agent', true)!, /may not be able to push a workflow file \(its scopes are unknown\)/);
  assert.equal(placementHint('m3', places, undefined, {}, undefined, 'agent', true), undefined, 'on the able one: no note');
  assert.match(placementHint('beast', [places[0]], undefined, {}, undefined, 'agent', true)!, /no computer whose gh may push it has room now: the worker pushes the rest and hands the workflow file on/);

  // The Capacity block names where such work goes next and each computer's login, once any daemon reported one.
  const line = workflowLine(places)!;
  assert.match(line, /^Next work that changes \.github\/workflows \(its push needs a gh token with the workflow scope, w1463\): m3 \(/);
  assert.match(line, /beast bryding \(gist, read:org, repo\): no; lothdesktop not reported: unknown; m3 bryding \(repo, workflow\): yes\./);
  assert.ok(capacityLines(places).includes(line));
  assert.equal(workflowLine([pc('beast'), pc('m3')]), undefined, 'no report yet: no line');
});

test("w1463: the daemon's watch reads gh at start, every 30 minutes and when gh's hosts file changes, and logs and sends no token", async () => {
  let now = NOW.getTime();
  let file = '10:1';
  const calls: string[][] = [];
  const sent: GhLogin[] = [];
  const logs: string[] = [];
  // A gh without --json (the text form), whose answer carries the token: none of it may come out.
  const run = async (_cmd: string, args: string[]): Promise<RunResult> => {
    calls.push(args);
    if (args.includes('--json')) return { code: 1, stdout: '', stderr: `unknown flag: --json\n${OAUTH}` };
    return { code: 0, stdout: BEAST_TEXT, stderr: '' };
  };
  const w = new GhLoginWatch({ run, look: () => file, now: () => new Date(now), send: (gh) => sent.push(gh), log: (l) => logs.push(l) });
  await w.tick();
  assert.equal(calls.length, 2, 'the JSON form, then the text form');
  assert.deepEqual(sent.map((g) => g.scopes), [['gist', 'read:org', 'repo', 'workflow']]);
  assert.deepEqual(logs, ['gh login: bryding (gist, read:org, repo, workflow)']);
  now += 60_000;
  await w.tick();
  assert.equal(calls.length, 2, 'nothing changed within 30 minutes: not read again');
  file = '12:2';
  await w.tick();
  assert.equal(calls.length, 4, "gh's hosts file changed (a gh auth refresh -s workflow): read at once");
  now += READ_EVERY_MS;
  await w.tick();
  assert.equal(calls.length, 6, '30 minutes on: read again');
  assert.equal(sent.length, 3);
  assert.equal(logs.length, 1, 'the same login is logged once');
  w.resend();
  assert.equal(sent.length, 4, 'a hello gives the portal the last reading');
  for (const x of [...sent.map((g) => JSON.stringify(g)), ...logs]) noToken('the watch', x);
  for (const a of calls) assert.ok(!a.includes('--show-token') && !a.includes('-t'), 'never asks gh for the token');
});

test('w1463: readGhLogin says when gh is missing, and the hosts file follows gh\'s own lookup order', async () => {
  const missing = await readGhLogin(async () => ({ code: -1, stdout: '', stderr: 'spawn gh ENOENT' }), NOW);
  assert.deepEqual([missing.ok, missing.error], [false, "gh is not installed (or not on the daemon's PATH)"]);
  const json = await readGhLogin(async () => ({ code: 0, stdout: BEAST_JSON, stderr: '' }), NOW);
  assert.equal(json.account, 'bryding');
  assert.equal(ghHostsFile({ GH_CONFIG_DIR: '/c/gh' }, 'linux', '/h'), path.join('/c/gh', 'hosts.yml'));
  assert.equal(ghHostsFile({ XDG_CONFIG_HOME: '/x' }, 'darwin', '/h'), path.join('/x', 'gh', 'hosts.yml'));
  assert.equal(ghHostsFile({ AppData: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'), path.join('C:\\Users\\a\\AppData\\Roaming', 'GitHub CLI', 'hosts.yml'));
  assert.equal(ghHostsFile({}, 'linux', '/h'), path.join('/h', '.config', 'gh', 'hosts.yml'));
});
