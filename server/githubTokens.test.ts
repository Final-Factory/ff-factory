import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GithubTokens, PORTAL_MACHINE, githubFromVault, githubHealthLine, githubPersonOf, parseExpiry } from './githubTokens.ts';
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
  new GithubTokens({ vault: () => vault, cfg: { machines }, run, payer: () => 'ben', now: () => NOW, ...extra });

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

test('probe: the account, the expiry and the reads per repository; a 401 stops the token; an expired one is not used', async (t) => {
  const { vault } = setup(t);
  const seen: { url: string; auth: string }[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, auth: init.headers.Authorization });
    const tok = init.headers.Authorization.slice('Bearer '.length);
    const p = url.slice('https://api.github.com/'.length);
    const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, json: async () => body });
    if (tok === LOTH) return reply(401);
    if (p === 'user') return reply(200, { login: 'bryding', id: 481770 }, { 'github-authentication-token-expiration': '2026-10-20 00:00:00 UTC' });
    if (p === 'repos/Final-Factory/ffbox') return reply(404);
    if (p === 'repos/Final-Factory/FinalFactory/actions/runs?per_page=1') return reply(403);
    return reply(200, []);
  };
  const g = tokens(vault, {}, undefined, { fetch, repos: () => ['Final-Factory/FinalFactory', 'Final-Factory/ffbox'] });
  await g.tick();
  const ben = g.list().find((h) => h.name === 'vault-ben-github')!;
  assert.equal(ben.login, 'bryding');
  assert.equal(ben.userId, 481770);
  assert.equal(ben.expiresAt, '2026-10-20T00:00:00.000Z');
  assert.deepEqual(ben.repos, [
    { repo: 'Final-Factory/FinalFactory', metadata: 'read', contents: 'read', pulls: 'read', actions: 'denied', statuses: 'read' },
    { repo: 'Final-Factory/ffbox', metadata: 'not-selected' },
  ]);
  const loth = g.list().find((h) => h.name === 'vault-lothsahn-github')!;
  assert.match(loth.bad ?? '', /401/);
  assert.equal(g.usable(loth.fingerprint), false);
  assert.ok(seen.every((s) => s.url.startsWith('https://api.github.com/')), 'only GitHub is asked');
  const line = githubHealthLine(ben, false, NOW);
  assert.match(line, /GitHub token vault-ben-github …bbbb \(ben's\); GitHub account bryding \(id 481770\); expires 2026-10-20 \(9 days\): rotate it soon; reads lacking: FinalFactory: no actions read; ffbox: not selected/);
  assert.match(line, /portal reads: off/);
  // A probe within PROBE_EVERY_MS is not repeated; past its expiry the token is not used.
  const n = seen.length;
  await g.tick();
  assert.equal(seen.length, n);
  const later = tokens(vault, { githubFromVault: true }, undefined, { fetch, now: () => Date.parse('2026-10-21T00:00:00Z') });
  await later.tick();
  assert.match(later.unusable(ben.fingerprint) ?? '', /expired 2026-10-20/);
  assert.equal(later.tokenFor('ben'), undefined, 'an expired token is not used: the portal login');
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
