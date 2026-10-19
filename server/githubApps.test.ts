import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { APP_READ_EVERY_MS, GithubApps, REFRESH_BEFORE_MS, appJwt, githubAppProblems } from './githubApps.ts';
import { GithubTokens } from './githubTokens.ts';
import { Vault, canonicalPem, newKeyText, type VaultContext } from './vault.ts';
import { machineRunEnv } from './secrets.ts';
import { githubCredentialEnv, GITHUB_HELPER } from './launch.ts';
import { GITHUB_APP_PERMISSIONS } from '../shared/githubRequirements.ts';
import { appTokenFor, ghRepoOf, gitRemoteRepo, repoKey, repoOfUrl, type GhAppToken } from '../shared/githubAppRoute.ts';
import { credentialAnswer, findRealGh, ghAppRunEnv, ghEnvFor, installGhAppShims, readGhAppTokens, writeGhAppTokens } from '../machine/ghApp.ts';
import type { RunOptions, RunResult } from './proc.ts';

/**
 * GitHub Apps (w1519, docs/github-apps.md): the vault entry, the JWT, minting and refreshing installation tokens, the owner
 * allowlist, routing per repository (the portal's gh, a worker's git and gh) and the health. Keys and tokens are made at run
 * time, so no scanner takes them for real ones.
 */

const NOW = Date.parse('2026-10-19T03:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ghs = (c: string) => ['ghs', '_', c.repeat(36)].join('');
const pat = (c: string) => ['github', '_pat_', c.repeat(40)].join('');
const LOTH = pat('l');
const PEM2 = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const { privateKey: PEM, publicKey: PUB } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

function setup(t: { after: (fn: () => void) => void }, app: Partial<Parameters<Vault['add']>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-ghapp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'vault.key');
  fs.writeFileSync(keyFile, newKeyText(), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const vault = new Vault({ file: path.join(dir, 'vault.json'), key: () => ({ file: keyFile }) });
  vault.add({ name: 'vault-lothsahn-github', kind: 'github', value: LOTH, owner: 'lothsahn', share: 'owner' });
  vault.add({ name: 'app-gherik', kind: 'github-app', value: PEM, appId: '123456', appOwners: ['Gherik1'], owner: 'lothsahn', share: 'anyone', ...app });
  return { dir, vault };
}

/** A GitHub that knows one app (id 123456) installed on Gherik1 (two repositories) and on a stranger. */
function fakeGithub(o: { status?: (method: string, p: string) => number | undefined; grants?: Record<string, string>; asks?: Record<string, string> } = {}) {
  const calls: { method: string; path: string; auth: string }[] = [];
  let minted = 0;
  const grants = o.grants ?? { actions: 'read', checks: 'read', contents: 'write', metadata: 'read', pull_requests: 'write' };
  const f = async (url: string, init: { method?: string; headers: Record<string, string> }) => {
    const method = init.method ?? 'GET';
    const p = url.replace('https://api.github.com/', '');
    const auth = init.headers.Authorization.replace(/^Bearer /, '');
    calls.push({ method, path: p, auth });
    const forced = o.status?.(method, p);
    const ans = (status: number, body?: unknown) => ({ status, json: async () => body });
    if (forced) return ans(forced, { message: 'no' });
    if (method === 'GET' && p === 'app') {
      // The JWT must verify with the app's public key and name the app.
      const [h, c, s] = auth.split('.');
      const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(createPublicKey(PUB), Buffer.from(s, 'base64url'));
      if (!ok || JSON.parse(Buffer.from(c, 'base64url').toString()).iss !== 123456) return ans(401, { message: 'A JSON web token could not be decoded' });
      return ans(200, { slug: 'ff-factory-mods', owner: { login: 'Final-Factory' }, permissions: o.asks ?? grants });
    }
    if (method === 'GET' && p.startsWith('app/installations?'))
      return ans(200, [
        { id: 11, account: { login: 'Gherik1' }, repository_selection: 'selected', permissions: grants },
        { id: 99, account: { login: 'stranger' }, repository_selection: 'all', permissions: grants },
      ]);
    const mint = /^app\/installations\/(\d+)\/access_tokens$/.exec(p);
    if (method === 'POST' && mint) {
      minted++;
      return ans(201, { token: ghs(String.fromCharCode(96 + minted)), expires_at: iso(NOW + minted * 3_600_000), permissions: grants, repository_selection: mint[1] === '99' ? 'all' : 'selected' });
    }
    if (method === 'GET' && p.startsWith('installation/repositories')) return ans(200, { repositories: [{ full_name: 'Gherik1/ItemCannon' }, { full_name: 'Gherik1/PlayerUpgrades' }] });
    if (method === 'DELETE' && p === 'app/installations/99') return ans(204);
    return ans(404, { message: 'Not Found' });
  };
  return { f, calls, minted: () => minted };
}

function apps(vault: Vault, gh: ReturnType<typeof fakeGithub>, clock: { now: number }, extra: Partial<ConstructorParameters<typeof GithubApps>[0]> = {}) {
  const logs: string[] = [];
  const reports: string[] = [];
  let pushes = 0;
  const a = new GithubApps({ vault: () => vault, fetch: gh.f, now: () => clock.now, log: (l) => logs.push(l), report: (t, b) => reports.push(`${t}: ${b}`), onTokens: () => pushes++, ...extra });
  return { a, logs, reports, pushes: () => pushes };
}

test('appJwt: RS256 over the key, issued 60 s back, expiring 9 min on, the App ID as a number (a Client ID as given)', () => {
  const [h, c, s] = appJwt('123456', PEM, NOW).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.deepEqual(claims, { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: 123456 });
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(createPublicKey(PUB), Buffer.from(s, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(appJwt('Iv23liAbCdEf', PEM, NOW).split('.')[1], 'base64url').toString()).iss, 'Iv23liAbCdEf');
});

test('vault: a GitHub App keeps its key as one canonical PEM (a one-line paste is the same key), shows the body\'s last four, needs its App ID and owners', (t) => {
  const { vault } = setup(t);
  const e = vault.list().find((x) => x.name === 'app-gherik')!;
  const body = PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  assert.equal(e.kind, 'github-app');
  assert.equal(e.last4, body.slice(-4));
  assert.equal(e.appId, '123456');
  assert.deepEqual(e.appOwners, ['Gherik1']);
  // Pasted into a one-line field: the line breaks gone, or spaces. The same key, so the same fingerprint (refused as a duplicate).
  assert.equal(canonicalPem(PEM.replace(/\n/g, '')), canonicalPem(PEM));
  assert.equal(canonicalPem(PEM.replace(/\n/g, ' ')), canonicalPem(PEM));
  assert.throws(() => vault.add({ name: 'again', kind: 'github-app', value: PEM.replace(/\n/g, ' '), appId: '1', appOwners: ['x'], share: 'anyone' }), /already in the vault as app-gherik/);
  assert.equal(vault.githubApps()[0].key, canonicalPem(PEM));
  assert.throws(() => vault.add({ name: 'noid', kind: 'github-app', value: PEM2, appOwners: ['x'], share: 'anyone' }), /App ID/);
  assert.throws(() => vault.add({ name: 'noowners', kind: 'github-app', value: PEM2, appId: '1', share: 'anyone' }), /accounts whose installations/);
  assert.throws(() => vault.add({ name: 'vault-x-app', kind: 'github-app', value: PEM2, appId: '1', appOwners: ['x'], share: 'anyone' }), /may not start with vault- or host-/);
  assert.throws(() => vault.add({ name: 'broken', kind: 'github-app', value: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----', appId: '1', appOwners: ['x'], share: 'anyone' }), /does not parse/);
  assert.throws(() => vault.add({ name: 'tok', kind: 'github', value: pat('q'), appId: '1', share: 'anyone', owner: 'ben' }), /only for kind github-app/);
  assert.equal(vault.update('app-gherik', { appOwners: ['Gherik1', 'other'] }).appOwners?.length, 2);
  assert.throws(() => vault.update('app-gherik', { appOwners: [] }), /accounts whose installations/);
});

test('GithubApps: reads the app, mints a token per allowed installation with its repositories, ignores an account off the allowlist', async (t) => {
  const { vault } = setup(t);
  const gh = fakeGithub();
  const clock = { now: NOW };
  const { a, pushes } = apps(vault, gh, clock);
  await a.tick();
  const toks = a.forMachine('m3');
  assert.equal(toks.length, 1, 'the stranger\'s installation is never used');
  assert.deepEqual(toks[0], { app: 'app-gherik', repos: ['gherik1/itemcannon', 'gherik1/playerupgrades'], owners: [], token: ghs('a'), expiresAt: iso(NOW + 3_600_000) });
  assert.equal(pushes(), 1);
  assert.ok(!gh.calls.some((c) => c.path === 'app/installations/99/access_tokens'), 'no token is minted for an installation off the allowlist');
  assert.ok(!gh.calls.some((c) => c.method === 'DELETE'), 'nothing is uninstalled unless the entry asks');
  const h = a.list()[0];
  assert.equal(h.slug, 'ff-factory-mods');
  assert.deepEqual(h.problems, []);
  assert.deepEqual(h.installations?.map((i) => [i.account, i.allowed]), [['Gherik1', true], ['stranger', false]]);
  assert.match(a.statusLines()[0], /^GitHub App app-gherik …\S{4} \(lothsahn's\), App ID 123456, ff-factory-mods owned by Final-Factory; key valid; Gherik1 \(installation 11\): 2 repositories \(gherik1\/itemcannon, gherik1\/playerupgrades\); grants Actions read, Checks read, Contents write, Metadata read, Pull requests write; token until 04:00Z; ignored, not on the allowlist: stranger \(installation 99\)/);
  assert.deepEqual(a.banners(), []);
});

test('GithubApps: the token is cached, minted again 15 minutes before its end, and the installations are read again hourly', async (t) => {
  const { vault } = setup(t);
  const gh = fakeGithub();
  const clock = { now: NOW };
  const { a, pushes } = apps(vault, gh, clock);
  await a.tick();
  assert.equal(gh.minted(), 1);
  clock.now = NOW + 3_600_000 - REFRESH_BEFORE_MS - 60_000;
  await a.tick();
  assert.equal(gh.minted(), 1, 'more than 15 minutes left: the same token');
  assert.equal(gh.calls.filter((c) => c.path === 'app').length, 1, 'the app is read once an hour, not each tick');
  clock.now = NOW + 3_600_000 - REFRESH_BEFORE_MS + 1;
  await a.tick();
  assert.equal(gh.minted(), 2, 'under 15 minutes left: a new token');
  assert.equal(a.forMachine('m3')[0].token, ghs('b'));
  assert.equal(pushes(), 2, 'the machines get the new token');
  clock.now = NOW + APP_READ_EVERY_MS + 1;
  await a.tick();
  assert.equal(gh.calls.filter((c) => c.path === 'app').length, 2);
  // Two ticks at once read once.
  await Promise.all([a.tick(true), a.tick(true)]);
  assert.equal(gh.calls.filter((c) => c.path === 'app').length, 3);
});

test('GithubApps: a refused key (401) is not used and shows on the banner; it is never logged', async (t) => {
  const { vault } = setup(t);
  const gh = fakeGithub({ status: (m, p) => (p === 'app' ? 401 : undefined) });
  const { a, logs, reports } = apps(vault, gh, { now: NOW });
  await a.tick();
  assert.deepEqual(a.forMachine('m3'), []);
  assert.match(a.list()[0].problems!.join(), /GitHub refused its JWT \(401\)/);
  assert.equal(a.banners().length, 1);
  assert.equal(reports.length, 1);
  const all = [...logs, ...reports, ...a.statusLines(), ...a.banners().map((b) => b.text), JSON.stringify(a.list())].join('\n');
  assert.ok(!all.includes('PRIVATE KEY') && !all.includes(PEM.split('\n')[1]), 'no part of the key');
});

test('GithubApps: a permission the installation lacks is a problem, worded by whether the app asks for it; Workflows is optional', async (t) => {
  const { vault } = setup(t);
  const grants = { contents: 'read', metadata: 'read', pull_requests: 'write', actions: 'read', checks: 'read' };
  const { a } = apps(vault, fakeGithub({ grants, asks: { ...grants, contents: 'write' } }), { now: NOW });
  await a.tick();
  assert.deepEqual(a.list()[0].problems, ["Contents (read and write) not accepted yet on Gherik1's installation: Gherik1 accepts the new permissions (Settings, Applications, the app, Review request)"]);
  const h = { checkedAt: iso(NOW), installations: [{ id: 1, account: 'Gherik1', allowed: true, permissions: { metadata: 'read' } }] } as never;
  assert.match(githubAppProblems(h, ['Gherik1'], {}).join('\n'), /Contents \(read and write\) is not asked for: set it on the app's settings/);
  assert.ok(!githubAppProblems(h, ['Gherik1'], {}).some((p) => /Workflows/.test(p)));
  const none = { checkedAt: iso(NOW), slug: 'ff-factory-mods', installations: [{ id: 9, account: 'stranger', allowed: false }] } as never;
  assert.deepEqual(githubAppProblems(none, ['Gherik1']), ['not installed on Gherik1: they install it from https://github.com/apps/ff-factory-mods/installations/new and select the repositories']);
});

test('GithubApps: uninstallOthers removes an installation off the allowlist (DELETE /app/installations/{id}), says so, and keeps Gherik1', async (t) => {
  const { vault } = setup(t, { uninstallOthers: true });
  const gh = fakeGithub();
  const { a, logs, reports } = apps(vault, gh, { now: NOW });
  await a.tick();
  assert.deepEqual(gh.calls.filter((c) => c.method === 'DELETE').map((c) => c.path), ['app/installations/99']);
  assert.match(logs.join('\n'), /uninstalled ff-factory-mods from stranger \(installation 99\): not on the allowlist \(Gherik1\)/);
  assert.equal(reports.length, 1);
  assert.equal(a.forMachine('beast').length, 1);
  assert.ok(!gh.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/11')));
});

test('GithubApps: machines get the tokens of apps granted to them; the portal only for people the entry serves', async (t) => {
  const { vault } = setup(t, { machines: ['m3'], share: 'owner' });
  const { a } = apps(vault, fakeGithub(), { now: NOW });
  await a.tick();
  assert.equal(a.forMachine('m3').length, 1);
  assert.equal(a.forMachine('beast').length, 0);
  assert.equal(a.forPortal('lothsahn', 'gherik1/itemcannon')?.token, ghs('a'));
  assert.equal(a.forPortal('ben', 'gherik1/itemcannon'), undefined, "an owner-only app serves its owner's work only");
  assert.equal(a.forPortal('lothsahn', 'final-factory/finalfactory'), undefined, 'a repository the app is not installed on: the person\'s own token');
});

test('the portal\'s gh: a repository the app covers runs on the app token, others on the person\'s; a refused app token falls back and is minted again', async (t) => {
  const { vault } = setup(t);
  const gh = fakeGithub();
  const { a } = apps(vault, gh, { now: NOW });
  await a.tick();
  const calls: { token?: string; args: string[] }[] = [];
  let refuse = false;
  const run = async (_c: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ token: opts.env?.GH_TOKEN, args });
    return refuse && opts.env?.GH_TOKEN?.startsWith('ghs_') ? { code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' } : { code: 0, stdout: '{}', stderr: '' };
  };
  const tokens = new GithubTokens({ vault: () => vault, cfg: { machines: { githubFromVault: true } }, run, apps: a, now: () => NOW, probePortalLogin: false });
  await tokens.runner('lothsahn', 'pr state')('gh', ['pr', 'view', '3', '-R', 'Gherik1/ItemCannon', '--json', 'state']);
  await tokens.runner('lothsahn', 'pr state')('gh', ['pr', 'view', '7', '-R', 'Final-Factory/FinalFactory', '--json', 'state']);
  await tokens.runner('lothsahn', 'runs')('gh', ['api', 'repos/Gherik1/PlayerUpgrades/actions/runs']);
  assert.deepEqual(calls.map((c) => c.token), [ghs('a'), LOTH, ghs('a')]);
  assert.match(a.list()[0].lastUse!.what, /runs/);
  refuse = true;
  calls.length = 0;
  await tokens.runner('lothsahn', 'pr state')('gh', ['pr', 'view', '3', '-R', 'Gherik1/ItemCannon']);
  assert.deepEqual(calls.map((c) => c.token), [ghs('a'), LOTH], 'refused: made again on the person\'s token');
  assert.equal(a.forMachine('m3').length, 0, 'the refused token is dropped');
  await a.tick();
  assert.equal(a.forMachine('m3')[0].token, ghs('b'), 'and minted again at the next tick');
  // The portal's reads off (machines.githubFromVault without "portal"): no app either.
  const off = new GithubTokens({ vault: () => vault, cfg: { machines: {} }, run, apps: a, now: () => NOW, probePortalLogin: false });
  calls.length = 0;
  await off.runner('lothsahn', 'x')('gh', ['pr', 'view', '-R', 'Gherik1/ItemCannon'], { env: {} });
  assert.equal(calls[0].token, undefined, "the portal's own login");
  // system_status and the banners carry the app.
  assert.ok(tokens.statusLines().some((l) => l.startsWith('GitHub App app-gherik')));
});

test('machineRunEnv: a run with a vault GitHub token gets the names of the apps it may use, never a key; none without one', (t) => {
  const { vault } = setup(t, { share: 'owner' });
  vault.add({ name: 'vault-lothsahn-1', kind: 'claude', value: `sk-ant-oat01-${'a'.repeat(48)}`, owner: 'lothsahn', share: 'owner' });
  vault.add({ name: 'vault-ben-1', kind: 'claude', value: `sk-ant-oat01-${'b'.repeat(48)}`, owner: 'ben', share: 'owner' });
  const ctx: VaultContext = { vault, payer: () => 'lothsahn' };
  const loth = machineRunEnv({ machines: { githubFromVault: true } } as never, { id: 'm3' }, { role: 'workers', requestedBy: { userId: 'lothsahn' } as never }, ctx);
  assert.equal(loth.env.FF_GH_APP_NAMES, 'app-gherik');
  assert.ok(!Object.values(loth.env).some((v) => v.includes('PRIVATE KEY')));
  const ben = machineRunEnv({ machines: { githubFromVault: true } } as never, { id: 'm3' }, { role: 'workers', requestedBy: { userId: 'ben' } as never }, ctx);
  assert.equal(ben.env.FF_GH_APP_NAMES, undefined, "an owner-only app: not Ben's");
  const off = machineRunEnv({ machines: {} } as never, { id: 'm3' }, { role: 'workers', requestedBy: { userId: 'lothsahn' } as never }, ctx);
  assert.equal(off.env.FF_GH_APP_NAMES, undefined, 'no vault GitHub token on the machine: no app (the helper would replace its own login)');
});

const TOKENS: GhAppToken[] = [
  { app: 'app-gherik', repos: ['gherik1/itemcannon', 'gherik1/playerupgrades'], owners: [], token: ghs('a'), expiresAt: iso(NOW + 3_600_000) },
  { app: 'other-app', repos: [], owners: ['someone'], token: ghs('o'), expiresAt: iso(NOW + 3_600_000) },
];

test('routing: the repository of a gh command line, a URL and a folder\'s remotes', () => {
  assert.equal(repoKey('Gherik1/ItemCannon.git'), 'gherik1/itemcannon');
  assert.equal(repoKey('/Gherik1/ItemCannon/'), 'gherik1/itemcannon');
  assert.equal(repoOfUrl('https://github.com/Gherik1/ItemCannon/pull/3'), 'gherik1/itemcannon');
  assert.equal(repoOfUrl('git@github.com:Gherik1/ItemCannon.git'), 'gherik1/itemcannon');
  assert.equal(repoOfUrl('https://gitlab.com/Gherik1/ItemCannon'), undefined);
  assert.equal(ghRepoOf(['pr', 'create', '-R', 'Gherik1/ItemCannon']), 'gherik1/itemcannon');
  assert.equal(ghRepoOf(['pr', 'view', '--repo=github.com/Gherik1/ItemCannon']), 'gherik1/itemcannon');
  assert.equal(ghRepoOf(['pr', 'view', '-RGherik1/ItemCannon']), 'gherik1/itemcannon');
  assert.equal(ghRepoOf(['pr', 'view', 'https://github.com/Gherik1/PlayerUpgrades/pull/2']), 'gherik1/playerupgrades');
  assert.equal(ghRepoOf(['api', '-X', 'GET', '/repos/Gherik1/ItemCannon/pulls?state=all']), 'gherik1/itemcannon');
  assert.equal(ghRepoOf(['repo', 'clone', 'Gherik1/ItemCannon', 'dir']), 'gherik1/itemcannon');
  assert.equal(ghRepoOf(['pr', 'list'], { GH_REPO: 'Gherik1/ItemCannon' }), 'gherik1/itemcannon');
  assert.equal(ghRepoOf(['pr', 'list']), undefined);
  assert.equal(gitRemoteRepo('remote.origin.url https://github.com/me/fork.git\nremote.upstream.url https://github.com/Gherik1/ItemCannon.git\n'), 'gherik1/itemcannon');
  assert.equal(gitRemoteRepo('remote.origin.url git@github.com:Gherik1/ItemCannon.git'), 'gherik1/itemcannon');
  assert.equal(gitRemoteRepo(''), undefined);
  assert.equal(appTokenFor(TOKENS, 'gherik1/itemcannon', ['app-gherik'], NOW)?.token, ghs('a'));
  assert.equal(appTokenFor(TOKENS, 'gherik1/otherrepo', ['app-gherik'], NOW), undefined, 'a repository Gherik1 did not select: the person\'s token');
  assert.equal(appTokenFor(TOKENS, 'someone/anything', ['other-app'], NOW)?.token, ghs('o'), 'an installation on all repositories covers the account');
  assert.equal(appTokenFor(TOKENS, 'gherik1/itemcannon', [], NOW), undefined, 'a run named no app');
  assert.equal(appTokenFor(TOKENS, 'gherik1/itemcannon', ['app-gherik'], NOW + 3_600_000 - 30_000), undefined, 'not in its last minute');
});

test('the git credential helper: the app token for its repositories, the run\'s GH_TOKEN for the rest, nothing elsewhere', () => {
  const env = { FF_GH_APP_NAMES: 'app-gherik', GH_TOKEN: LOTH };
  const ask = (input: string, op = 'get', e: Record<string, string> = env) => credentialAnswer(op, input, e, TOKENS, NOW);
  assert.equal(ask('protocol=https\nhost=github.com\npath=Gherik1/ItemCannon.git\n'), `username=x-access-token\npassword=${ghs('a')}\n`);
  assert.equal(ask('protocol=https\nhost=github.com\npath=Final-Factory/FinalFactory.git\n'), `username=x-access-token\npassword=${LOTH}\n`);
  assert.equal(ask('protocol=https\nhost=github.com\n'), `username=x-access-token\npassword=${LOTH}\n`, 'no path (useHttpPath off): the run\'s token');
  assert.equal(ask('protocol=https\nhost=gitlab.com\npath=Gherik1/ItemCannon.git\n'), '');
  assert.equal(ask('protocol=https\nhost=github.com\npath=Gherik1/ItemCannon.git\n', 'store'), '');
  assert.equal(ask('protocol=https\nhost=github.com\npath=Gherik1/ItemCannon.git\n', 'get', { GH_TOKEN: LOTH }), `username=x-access-token\npassword=${LOTH}\n`, 'a run named no app');
});

test('gh: GH_TOKEN becomes the app token for its repositories (args, then the folder\'s remotes), else the environment is unchanged', () => {
  const env = { FF_GH_APP_NAMES: 'app-gherik', GH_TOKEN: LOTH, GITHUB_TOKEN: 'x' };
  assert.equal(ghEnvFor(['pr', 'create', '-R', 'Gherik1/ItemCannon'], env, TOKENS, () => '', NOW).GH_TOKEN, ghs('a'));
  assert.equal(ghEnvFor(['pr', 'create', '-R', 'Gherik1/ItemCannon'], env, TOKENS, () => '', NOW).GITHUB_TOKEN, undefined);
  assert.equal(ghEnvFor(['pr', 'create'], env, TOKENS, () => 'remote.origin.url https://github.com/Gherik1/PlayerUpgrades.git', NOW).GH_TOKEN, ghs('a'));
  assert.equal(ghEnvFor(['pr', 'create'], env, TOKENS, () => 'remote.origin.url https://github.com/Final-Factory/FinalFactory.git', NOW), env);
  let looked = false;
  assert.equal(ghEnvFor(['pr', 'create'], { GH_TOKEN: LOTH }, TOKENS, () => ((looked = true), ''), NOW).GH_TOKEN, LOTH);
  assert.equal(looked, false, 'a run with no app does not even read the remotes');
});

test('the daemon side: the tokens file round trip (0600), the run environment only with apps and a vault token, the real gh past the shim', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-ghapp-m-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gh-app', 'tokens.json');
  writeGhAppTokens(file, TOKENS);
  assert.deepEqual(readGhAppTokens(file), TOKENS);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readGhAppTokens(path.join(dir, 'none.json')), []);
  const setup = { bin: path.join(dir, 'gh-app', 'bin'), file, helper: '!helper credential' };
  assert.deepEqual(ghAppRunEnv({ GH_TOKEN: LOTH }, setup, 'PATH', '/usr/bin'), {});
  assert.deepEqual(ghAppRunEnv({ FF_GH_APP_NAMES: 'a' }, setup, 'PATH', '/usr/bin'), {}, 'no vault GitHub token: nothing');
  assert.deepEqual(ghAppRunEnv({ FF_GH_APP_NAMES: 'a', GH_TOKEN: LOTH }, setup, 'Path', 'C:\\x'), { FF_GH_APP_FILE: file, FF_GH_APP_HELPER: '!helper credential', Path: [setup.bin, 'C:\\x'].join(path.delimiter) });
  // gh: the first one on PATH that is not in the shim's folder.
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  fs.mkdirSync(setup.bin, { recursive: true });
  const exe = process.platform === 'win32' ? 'gh.exe' : 'gh';
  for (const d of [setup.bin, real]) fs.writeFileSync(path.join(d, exe), '', { mode: 0o755 });
  assert.equal(findRealGh([setup.bin, real].join(path.delimiter), setup.bin), path.join(real, exe));
  assert.equal(findRealGh(setup.bin, setup.bin), undefined);
});

test('git config: with apps the helper is the daemon\'s and git sends the path (useHttpPath); without, the GH_TOKEN helper as before', () => {
  assert.deepEqual(githubCredentialEnv({}), { GIT_CONFIG_KEY_0: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: GITHUB_HELPER, GIT_CONFIG_COUNT: '2' });
  assert.deepEqual(githubCredentialEnv({ GIT_CONFIG_COUNT: '1', FF_GH_APP_HELPER: '!h credential' }), {
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_2: '!h credential',
    GIT_CONFIG_KEY_3: 'credential.https://github.com.useHttpPath',
    GIT_CONFIG_VALUE_3: 'true',
    GIT_CONFIG_COUNT: '4',
  });
});

test('real git: `git credential fill` through the installed helper answers the app token for Gherik1/ItemCannon and GH_TOKEN for another repository', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('no git');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-ghapp-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tokens.json');
  writeGhAppTokens(file, [{ ...TOKENS[0], expiresAt: iso(Date.now() + 3_600_000) }]);
  const helper = installGhAppShims(path.join(dir, 'bin'));
  const env = { ...process.env, ...githubCredentialEnv({ FF_GH_APP_HELPER: helper }), FF_GH_APP_FILE: file, FF_GH_APP_NAMES: 'app-gherik', GH_TOKEN: LOTH, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', HOME: dir, XDG_CONFIG_HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
  const fill = (url: string) => spawnSync('git', ['credential', 'fill'], { input: `url=${url}\n\n`, env, encoding: 'utf8', timeout: 60_000 });
  const app = fill('https://github.com/Gherik1/ItemCannon.git');
  assert.equal(app.status, 0, app.stderr);
  assert.match(app.stdout, new RegExp(`^password=${ghs('a')}$`, 'm'));
  assert.match(app.stdout, /^path=Gherik1\/ItemCannon\.git$/m, 'git sent the path');
  const other = fill('https://github.com/Final-Factory/FinalFactory.git');
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, new RegExp(`^password=${LOTH}$`, 'm'));
});

test('docs/github-apps.md lists exactly the permissions of GITHUB_APP_PERMISSIONS, with their access', () => {
  const doc = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'github-apps.md'), 'utf8');
  const rows = [...doc.matchAll(/^\s*\| (Actions|Checks|Contents|Metadata|Pull requests|Workflows) \| (Read and write|Read-only)( \(optional\))? \|/gm)].map((m) => [m[1], m[2], !!m[3]]);
  assert.deepEqual(rows, GITHUB_APP_PERMISSIONS.map((p) => [p.label, p.access === 'write' ? 'Read and write' : 'Read-only', !!p.optional]));
});
