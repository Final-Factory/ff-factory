import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GithubTokens, PORTAL_MACHINE, githubFromVault, githubHealthLine, githubPersonOf, parseExpiry, parseGhInclude } from './githubTokens.ts';
import { GITHUB_REQUIRED_PERMISSIONS, GITHUB_REQUIRED_REPOS } from '../shared/githubRequirements.ts';
import { Vault, newKeyText } from './vault.ts';
import { ghChecks } from './blockerWatch.ts';
import { githubNetEnv } from '../machine/daemon.ts';
import { GITHUB_HELPER } from './launch.ts';
import { setAppConfig, OWNER_ONLY_KEYS } from './appConfig.ts';
import type { RunOptions, RunResult } from './proc.ts';
import type { Config } from './config.ts';

/** Per-person GitHub tokens (w868, docs/vault.md section 13). Fake tokens are built at run time so no scanner takes them for real ones. */

const pat = (c: string) => ['github', '_pat_', c.repeat(40)].join('');
const BEN = pat('b');
const LOTH = pat('l');
const SHARED = pat('s');
const NOW = Date.parse('2026-10-10T12:00:00Z');

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-github-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'vault.key');
  fs.writeFileSync(keyFile, newKeyText(), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const vault = new Vault({ file: path.join(dir, 'vault.json'), key: () => ({ file: keyFile }) });
  vault.add({ name: 'vault-ben-github', kind: 'github', value: BEN, owner: 'ben', share: 'owner' });
  vault.add({ name: 'vault-lothsahn-github', kind: 'github', value: LOTH, owner: 'lothsahn', share: 'owner' });
  return { dir, vault };
}

/** A gh that answers by the token it is given: `answers(token, args)` → [code, stdout, stderr]. */
function fakeGh(answers: (token: string | undefined, args: string[]) => [number, string, string]) {
  const calls: { token?: string; args: string[] }[] = [];
  const run = async (_cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    const token = opts.env?.GH_TOKEN;
    calls.push({ token, args });
    const [code, stdout, stderr] = answers(token, args);
    return { code, stdout, stderr };
  };
  return { run, calls };
}

const tokens = (vault: Vault, machines: Config['machines'], run?: ReturnType<typeof fakeGh>['run'], extra: Partial<ConstructorParameters<typeof GithubTokens>[0]> = {}) =>
  new GithubTokens({ vault: () => vault, cfg: { machines }, run, payer: () => 'ben', now: () => NOW, probePortalLogin: !!run, ...extra });

test('githubFromVault: off by default; true, false or per machine with "*"; "portal" is the portal\'s own reads', () => {
  assert.equal(githubFromVault({ machines: {} }, 'm3'), false);
  assert.equal(githubFromVault({ machines: { githubFromVault: true } }, PORTAL_MACHINE), true);
  const per = { machines: { githubFromVault: { m3: true, '*': false } } };
  assert.equal(githubFromVault(per, 'M3'), true);
  assert.equal(githubFromVault(per, 'beast'), false);
  assert.equal(githubFromVault(per, PORTAL_MACHINE), false);
  assert.equal(githubFromVault({ machines: { githubFromVault: { portal: true } } }, 'portal'), true);
});

test('githubPersonOf: the configured person for unnamed work, else the requester, else the system payer', () => {
  assert.equal(githubPersonOf('lothsahn', { requestedBy: { userId: 'ben', displayName: 'Ben' } }, 'ben'), 'lothsahn');
  assert.equal(githubPersonOf(undefined, { requestedBy: { userId: 'ben', displayName: 'Ben' } }, 'lothsahn'), 'ben');
  assert.equal(githubPersonOf(undefined, undefined, 'ben'), 'ben');
});

test('portal reads: off, gh runs on the portal\'s own login; on, on the request person\'s token; request-less on the payer\'s; never another person\'s', async (t) => {
  const { vault } = setup(t);
  const gh = fakeGh(() => [0, '{}', '']);
  const off = tokens(vault, {}, gh.run);
  await off.runner('lothsahn', 'x')('gh', ['pr', 'view', '1'], { env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  assert.equal(gh.calls.at(-1)!.token, process.env.GH_TOKEN, 'off: the environment it had');
  const on = tokens(vault, { githubFromVault: { portal: true } }, gh.run);
  await on.runner('lothsahn', 'CI on #1')('gh', ['pr', 'view', '1']);
  assert.equal(gh.calls.at(-1)!.token, LOTH);
  await on.runner('ben', 'CI on #2')('gh', ['pr', 'view', '2']);
  assert.equal(gh.calls.at(-1)!.token, BEN);
  await on.runner(undefined, 'the ledger sweep')('gh', ['pr', 'list']);
  assert.equal(gh.calls.at(-1)!.token, BEN, 'no request: the system payer\'s');
  // Someone with no token of their own: the portal's own login, never another person's token.
  await on.runner('mate', 'x')('gh', ['pr', 'view', '3'], { env: { PATH: '/bin' } });
  assert.equal(gh.calls.at(-1)!.token, undefined);
  // A token shared with anyone serves them.
  vault.add({ name: 'bot-github', kind: 'github', value: SHARED, share: 'anyone' });
  await on.runner('mate', 'x')('gh', ['pr', 'view', '3']);
  assert.equal(gh.calls.at(-1)!.token, SHARED);
  const loth = on.list().find((h) => h.name === 'vault-lothsahn-github')!;
  assert.deepEqual(loth.lastUse, { at: new Date(NOW).toISOString(), what: 'CI on #1' });
});

test('portal reads: a 401 marks the token bad and the call is made again on the portal login; a 403 is noted; a refused statusCheckRollup is not the token\'s fault', async (t) => {
  const { vault } = setup(t);
  const logged: string[] = [];
  const gh = fakeGh((token, args) => {
    if (token === LOTH) return [1, '', 'HTTP 401: Bad credentials (https://api.github.com/graphql)'];
    if (token === BEN && args.includes('state,statusCheckRollup')) return [1, '', 'GraphQL: Resource not accessible by personal access token (repository.pullRequest.statusCheckRollup.nodes.0)'];
    if (token === BEN && args[0] === 'api') return [1, '', 'gh: Resource not accessible by personal access token (HTTP 403)'];
    if (args.includes('state,headRefOid')) return [0, JSON.stringify({ state: 'OPEN', headRefOid: 'abc' }), ''];
    if (args[0] === 'api') return [0, JSON.stringify({ workflow_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }), ''];
    return [0, '{"state":"OPEN"}', ''];
  });
  const g = tokens(vault, { githubFromVault: true }, gh.run, { log: (l) => logged.push(l) });
  const r = await g.runner('lothsahn', 'the state of #5')('gh', ['pr', 'view', '5']);
  assert.equal(r.code, 0, 'answered on the portal login');
  assert.deepEqual(gh.calls.slice(-2).map((c) => c.token), [LOTH, process.env.GH_TOKEN]);
  assert.match(g.unusable(vault.list().find((e) => e.name === 'vault-lothsahn-github')!.fingerprint) ?? '', /refused \(401\)/);
  await g.runner('lothsahn', 'again')('gh', ['pr', 'view', '5']);
  assert.equal(gh.calls.at(-1)!.token, process.env.GH_TOKEN, 'a refused token is not used again');
  // Ben's token reads no checks (no fine-grained token can) and lacks Actions: read here.
  const before = gh.calls.length;
  const ci = await ghChecks('Final-Factory/FinalFactory#9', g.runner('ben', 'CI on #9'));
  assert.equal(ci.done, true, 'read on the portal login after the 403');
  assert.deepEqual(gh.calls.slice(before).map((c) => [c.token === BEN ? 'ben' : 'portal', c.args.includes('state,statusCheckRollup') ? 'rollup' : c.args[0] === 'api' ? 'runs' : 'pr']), [
    ['ben', 'rollup'],
    ['ben', 'pr'],
    ['ben', 'runs'],
    ['portal', 'runs'],
  ]);
  const ben = g.list().find((h) => h.name === 'vault-ben-github')!;
  assert.match(ben.lastError?.what ?? '', /^CI on #9: a permission is missing \(403\)/);
  assert.equal(ben.bad, undefined, 'a 403 does not stop the token');
  assert.ok(!JSON.stringify([logged, g.list(), g.statusLines()]).includes(LOTH.slice(11, 30)), 'no value is logged or listed');
});

test('parseExpiry: GitHub\'s header form and ISO', () => {
  assert.equal(parseExpiry('2027-10-01 00:00:00 UTC'), '2027-10-01T00:00:00.000Z');
  assert.equal(parseExpiry('2027-10-01T00:00:00Z'), '2027-10-01T00:00:00.000Z');
  assert.equal(parseExpiry('soon'), undefined);
  assert.equal(parseExpiry(null), undefined);
});

/**
 * A GitHub that answers by token and path (w904). `deny` lists what the token is refused, as "<permission>@<repo short
 * name>" or "repo:<short name>" (not selected) or "org:<permission>"; everything else is allowed.
 */
function fakeGithub(byToken: Record<string, { deny?: string[]; status?: number; expiry?: string; login?: string; id?: number }>) {
  const seen: { url: string; auth: string }[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    seen.push({ url, auth: init.headers.Authorization });
    const g = byToken[init.headers.Authorization.slice('Bearer '.length)] ?? { status: 401 };
    const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, json: async () => body });
    const deny = new Set(g.deny ?? []);
    if (g.status) return reply(g.status);
    const p = url.slice('https://api.github.com/'.length);
    if (p === 'user') return reply(200, { login: g.login ?? 'someone', id: g.id ?? 1 }, g.expiry ? { 'github-authentication-token-expiration': g.expiry } : {});
    if (p === 'graphql') {
      const repo = /name:"([^"]+)"/.exec(JSON.parse(init.body ?? '{}').query)?.[1];
      return deny.has(`discussions@${repo}`) ? reply(200, { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] }) : reply(200, { data: { repository: { discussions: { totalCount: 0 } } } });
    }
    if (p.startsWith('orgs/Final-Factory/actions/runners')) return reply(deny.has('org:self-hosted-runners') ? 403 : 200, { runners: [] });
    if (p.startsWith('orgs/Final-Factory/artifacts/')) return reply(deny.has('org:artifact-metadata') ? 403 : 404);
    const m = /^repos\/Final-Factory\/([^/]+)(?:\/(.*))?$/.exec(p)!;
    const [, repo, rest = ''] = m;
    if (deny.has(`repo:${repo}`)) return reply(404);
    const perm = rest.startsWith('actions/') ? 'actions' : rest.startsWith('pulls') ? 'pull-requests' : rest.startsWith('issues') ? 'issues' : rest.endsWith('/status') ? 'commit-statuses' : rest.startsWith('commits') ? 'contents' : 'metadata';
    return reply(deny.has(`${perm}@${repo}`) ? 403 : 200, []);
  };
  return { fetch, seen };
}

test('probe (w904): every required repository and every readable permission; a 401 stops the token; an expired one is not used', async (t) => {
  const { vault } = setup(t);
  const gh = fakeGithub({
    [BEN]: { login: 'bryding', id: 481770, expiry: '2026-10-20 00:00:00 UTC', deny: ['actions@FinalFactory', 'repo:ffbox', 'discussions@KNN', 'org:self-hosted-runners'] },
  });
  const g = tokens(vault, {}, undefined, { fetch: gh.fetch, probePortalLogin: false });
  await g.tick();
  const ben = g.list().find((h) => h.name === 'vault-ben-github')!;
  assert.equal(ben.login, 'bryding');
  assert.equal(ben.userId, 481770);
  assert.equal(ben.expiresAt, '2026-10-20T00:00:00.000Z');
  assert.equal(ben.repos?.length, GITHUB_REQUIRED_REPOS.length, 'all nine');
  assert.deepEqual(ben.repos!.find((r) => r.repo === 'Final-Factory/FinalFactory')!.access, { metadata: 'read', contents: 'read', 'pull-requests': 'read', actions: 'denied', issues: 'read', 'commit-statuses': 'read', discussions: 'read' });
  assert.deepEqual(ben.repos!.find((r) => r.repo === 'Final-Factory/ffbox')!.access, { metadata: 'not-selected' });
  assert.deepEqual(ben.problems, [
    'expires 2026-10-20 (in 9 days)',
    'Self-hosted runners (organization Final-Factory): read refused',
    'Final-Factory/ffbox: not selected',
    'Actions: read refused on FinalFactory',
    'Discussions: read refused on KNN',
  ]);
  const loth = g.list().find((h) => h.name === 'vault-lothsahn-github')!;
  assert.match(loth.bad ?? '', /401/);
  assert.deepEqual(loth.problems, ['GitHub refused it (401): revoked, expired or mistyped']);
  assert.equal(g.usable(loth.fingerprint), false);
  assert.ok(gh.seen.every((s) => s.url.startsWith('https://api.github.com/')), 'only GitHub is asked');
  assert.match(githubHealthLine(ben, false, NOW), /GitHub token vault-ben-github …bbbb \(ben's\); GitHub account bryding \(id 481770\); expires 2026-10-20 \(9 days\): rotate it soon; lacks: Self-hosted runners/);
  // A probe within PROBE_EVERY_MS is not repeated; past its expiry the token is not used.
  const n = gh.seen.length;
  await g.tick();
  assert.equal(gh.seen.length, n);
  const later = tokens(vault, { githubFromVault: true }, undefined, { fetch: gh.fetch, probePortalLogin: false, now: () => Date.parse('2026-10-21T00:00:00Z') });
  await later.tick();
  assert.match(later.unusable(ben.fingerprint) ?? '', /expired 2026-10-20/);
  assert.equal(later.tokenFor('ben'), undefined, 'an expired token is not used: the portal login');
  // A permission refused on every repository is said once.
  const all = tokens(vault, {}, undefined, { fetch: fakeGithub({ [BEN]: { deny: GITHUB_REQUIRED_REPOS.map((r) => `issues@${r.split('/')[1]}`) } }).fetch, probePortalLogin: false });
  await all.tick();
  assert.ok(all.list().find((h) => h.name === 'vault-ben-github')!.problems!.includes('Issues: read refused on every repository'));
});

test('banner (w904): one per token lacking something, for its person and the owners, naming the token, what it lacks and the fix; [host] once bad, once recovered; Re-check now', async (t) => {
  const { vault } = setup(t);
  const reports: string[] = [];
  let deny = ['repo:ff-marketing', 'repo:ff-orchestrator-memory'];
  const gh = { fetch: (u: string, i: { headers: Record<string, string>; body?: string }) => fakeGithub({ [BEN]: { login: 'bryding', expiry: '2027-10-01 00:00:00 UTC' }, [LOTH]: { login: 'Lothsahn', id: 10092359, expiry: '2027-10-01 00:00:00 UTC', deny } }).fetch(u, i) };
  let now = NOW;
  const g = tokens(vault, {}, undefined, { fetch: gh.fetch, probePortalLogin: false, report: (title, body) => reports.push(`${title}: ${body}`), now: () => now });
  await g.tick();
  const banners = g.banners();
  assert.equal(banners.length, 1, "only lothsahn's lacks something");
  assert.equal(banners[0].person, 'lothsahn');
  assert.match(banners[0].text, /^vault-lothsahn-github …llll \(GitHub Lothsahn\) lacks: Final-Factory\/ff-marketing: not selected; Final-Factory\/ff-orchestrator-memory: not selected\. Edit the token on github\.com .*Repository access and Permissions\. Its value stays/);
  assert.match(banners[0].text, /Re-check now/);
  assert.match(banners[0].text, /Not checked \(they cannot be read without writing\): Actions write, Commit statuses write, Contents write, Discussions write, Issues write, Pull requests write, Workflows \(write only\)/);
  assert.ok(!banners[0].text.includes(LOTH.slice(11, 30)), 'never a value');
  assert.equal(reports.length, 1);
  assert.match(reports[0], /^vault-lothsahn-github …llll needs updating on GitHub: /);
  assert.ok(g.statusLines().some((l) => /^WARNING: GitHub token vault-lothsahn-github/.test(l)));
  // Fixed on github.com; Re-check now reads it at once (not more than every 30 seconds), and it clears by itself.
  deny = [];
  now += 1000;
  assert.equal(await g.recheck(), true);
  assert.deepEqual(g.banners(), []);
  assert.match(reports[1], /^vault-lothsahn-github …llll has everything it needs again: /);
  assert.equal(await g.recheck(), false, 'again within 30 s: refused');
  await g.tick(true);
  assert.equal(reports.length, 2, 'said once');
});

test('the portal\'s own gh login (D7) is probed through gh itself: gh api -i, never a value in the portal', async (t) => {
  const { vault } = setup(t);
  const calls: string[][] = [];
  const run = async (_cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push(args);
    assert.equal(opts.env?.GH_TOKEN, undefined, "gh's own login, not a vault token");
    if (args[1] === 'graphql') return { code: 0, stdout: '{"data":{}}', stderr: '' };
    const p = args[2];
    const http = (status: string, body = '{}', extra = '') => ({ code: status.startsWith('200') ? 0 : 1, stdout: `HTTP/2.0 ${status}\nContent-Type: application/json\n${extra}\n${body}`, stderr: '' });
    if (p === 'user') return http('200 OK', '{"login":"ff-portal-bot","id":42}', 'Github-Authentication-Token-Expiration: 2027-01-01 00:00:00 UTC\n');
    if (p.includes('/actions/runs')) return http('403 Forbidden', '{"message":"Resource not accessible by personal access token"}');
    if (p.startsWith('orgs/Final-Factory/actions/runners')) return http('200 OK', '{"runners":[]}');
    if (p.startsWith('orgs/')) return http('404 Not Found');
    return http('200 OK', '[]');
  };
  const g = tokens(vault, {}, run, { fetch: fakeGithub({}).fetch });
  await g.tick();
  const d7 = g.list().find((h) => h.portal)!;
  assert.equal(d7.name, "the portal's own gh login (D7)");
  assert.equal(d7.login, 'ff-portal-bot');
  assert.equal(d7.expiresAt, '2027-01-01T00:00:00.000Z');
  assert.deepEqual(d7.problems, ['Actions: read refused on every repository']);
  assert.match(g.banners().find((b) => b.id === 'github:portal-login')!.text, /^the portal's own gh login \(D7\) \(GitHub ff-portal-bot\) lacks: Actions: read refused on every repository\. Edit the portal's token on github\.com/);
  assert.equal(g.banners().find((b) => b.id === 'github:portal-login')!.person, undefined, 'the owners');
  assert.ok(calls.every((a) => a[0] === 'api'));
});

test('parseGhInclude: the status, headers and body gh api -i prints (measured: on errors too)', async () => {
  const a = parseGhInclude('HTTP/2.0 404 Not Found\nContent-Type: application/json\nX-Thing: y\n\n{"message":"Not Found"}')!;
  assert.equal(a.status, 404);
  assert.equal(a.header('x-thing'), 'y');
  assert.deepEqual(await a.json(), { message: 'Not Found' });
  assert.equal(parseGhInclude('gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.'), undefined);
});

test('the requirements are one list: docs/vault.md 13.2 names exactly these repositories and permissions', () => {
  const doc = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'vault.md'), 'utf8');
  const section = doc.slice(doc.indexOf('### 13.2'), doc.indexOf('### 13.3'));
  const listed = [...section.matchAll(/^\| (Final-Factory\/[A-Za-z0-9_.-]+) .*\| required \|/gm)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...GITHUB_REQUIRED_REPOS].sort(), 'the required repositories in 13.2');
  for (const p of GITHUB_REQUIRED_PERMISSIONS) {
    const want = p.access === 'write' ? 'Read and write' : 'Read-only';
    assert.match(section, new RegExp(`^\\| ${p.label} \\((repository|organization)\\) \\| \\*\\*${want}\\*\\* \\|`, 'm'), `13.2 lists ${p.label}: ${want}`);
  }
  assert.equal([...section.matchAll(/^\| [A-Z][A-Za-z -]+ \((repository|organization)\) \| \*\*/gm)].length, GITHUB_REQUIRED_PERMISSIONS.length, 'and no other permission');
});

test('daemon: a switch or save with a GitHub token pushes on it through the credential helper; none, the machine\'s own login', () => {
  assert.equal(githubNetEnv(undefined), undefined);
  const env = githubNetEnv(BEN)!;
  assert.equal(env.GH_TOKEN, BEN);
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
  assert.equal(env[`GIT_CONFIG_VALUE_${n + 1}`], GITHUB_HELPER);
  assert.equal(env.GIT_CONFIG_COUNT, String(n + 2));
});

test('set_app_config machines.githubFromVault: an owner\'s switch, per machine or "portal"', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-github-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}\n');
  const cfg = { machines: {} } as unknown as Config;
  assert.ok(OWNER_ONLY_KEYS.has('machines.githubFromVault'));
  assert.deepEqual(setAppConfig(file, cfg, 'machines.githubFromVault', true, { machine: 'portal' }), { before: undefined, after: { portal: true } });
  setAppConfig(file, cfg, 'machines.githubFromVault', true, { machine: 'm3' });
  assert.deepEqual(cfg.machines?.githubFromVault, { portal: true, m3: true }, 'live');
  assert.equal(githubFromVault(cfg, 'm5'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).machines.githubFromVault, { portal: true, m3: true });
  assert.throws(() => setAppConfig(file, cfg, 'machines.githubFromVault', 'maybe'), /machines\.githubFromVault is true/);
});
