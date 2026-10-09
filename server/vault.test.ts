import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NIGHTLY_SENTRY, UNATTRIBUTED_DEFAULTS, Vault, tokenPersonForWork, unattributedKind, unattributedPerson, eligible, type KeySource, envNameProblem, fingerprintOf, keySource, newKeyText, readKey, valueProblem, vaultStatusLine, type VaultEntryMeta, type VaultContext } from './vault.ts';
import { SECRET_ENV, addSecretValues, claudeFromVault, machineRunEnv, redactSecrets, registerSecretValues } from './secrets.ts';
import { GITHUB_HELPER, githubCredentialEnv } from './launch.ts';
import { buildAccounts, tokenKey } from './usage.ts';
import { checkAccountConfig, loadConfig } from './config.ts';
import { enrolledMachines, issueMachineToken, revokeMachineToken } from './machineTokens.ts';
import type { PlanUsage } from '../shared/types.ts';

/** The token vault (docs/vault.md, w512). Fake secrets are built at run time so no scanner mistakes them for real ones. */

const claudeTok = (c: string) => `sk-ant-oat01-${c.repeat(44)}`;
const ghTok = (c: string) => ['ghp', '_', c.repeat(36)].join('');
const A = claudeTok('a');
const B = claudeTok('b');
const C = claudeTok('c');
const GH = ghTok('g');
const DISCORD = ['dsc', 'secretvalue', '1234'].join('-');

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  const keyFile = path.join(dir, 'etc', 'vault.key');
  fs.mkdirSync(path.dirname(keyFile));
  fs.writeFileSync(keyFile, newKeyText(), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const values: string[][] = [];
  const make = (key: () => KeySource = () => ({ file: keyFile })) => new Vault({ file: path.join(data, 'vault.json'), key, onValues: (v) => values.push(v) });
  return { dir, data, keyFile, make, values };
}

test('vault: a value is sealed on disk and never listed; only its fingerprint and last four show', (t) => {
  const { data, make, values } = setup(t);
  const v = make();
  const e = v.add({ name: 'ben-max', kind: 'claude', value: A, owner: 'ben', share: 'owner' });
  assert.equal(e.fingerprint, fingerprintOf(A));
  assert.equal(`token:${e.fingerprint}`, tokenKey(A), 'the fingerprint is the usage meters key');
  assert.equal(e.last4, A.slice(-4));
  assert.deepEqual(e.roles, ['workers', 'standing']);
  assert.deepEqual(e.machines, ['*']);
  const disk = fs.readFileSync(path.join(data, 'vault.json'), 'utf8');
  assert.ok(!disk.includes(A.slice(13, 40)), 'no plaintext on disk');
  assert.ok(!JSON.stringify(v.list()).includes(A.slice(13, 40)), 'no value in the listing');
  assert.deepEqual(values.at(-1), [A], 'redaction learned the value');
  // A second reader (fffctl next to the portal) sees the same entries.
  assert.deepEqual(make().list().map((x) => x.name), ['ben-max']);
  assert.equal(v.status().key, 'loaded');
});

test('vault: what each kind accepts; names and env variables are checked; duplicates refused', (t) => {
  const { make } = setup(t);
  const v = make();
  assert.match(valueProblem('claude', 'sk-ant-api03-nope') ?? '', /not a Claude OAuth token/);
  assert.match(valueProblem('github', 'not-a-token') ?? '', /not a GitHub token/);
  assert.match(valueProblem('env', 'short') ?? '', /8 to 4096/);
  assert.match(valueProblem('env', 'two words here') ?? '', /whitespace/);
  assert.equal(valueProblem('github', GH), undefined);
  assert.equal(envNameProblem('FFDISCORD_APP_TOKEN'), undefined);
  assert.match(envNameProblem('PATH') ?? '', /ends in _TOKEN/);
  assert.match(envNameProblem('GIT_ASKPASS_TOKEN') ?? '', /GIT_ variables/);
  assert.match(envNameProblem('CLAUDE_CODE_OAUTH_TOKEN') ?? '', /kind claude/);
  assert.throws(() => v.add({ name: 'Bad Name', kind: 'claude', value: A, owner: 'ben', share: 'anyone' }), /a name is/);
  assert.throws(() => v.add({ name: 'x', kind: 'claude', value: A }), /needs --owner/);
  assert.throws(() => v.add({ name: 'x', kind: 'env', value: DISCORD, share: 'anyone' }), /variable name/);
  assert.throws(() => v.add({ name: 'x', kind: 'claude', value: A, owner: 'ben', share: 'anyone', roles: ['orchestrator' as never] }), /roles are/);
  assert.throws(() => v.add({ name: 'x', kind: 'claude', value: A, owner: 'ben', share: 'anyone', machines: ['M 3'] }), /machines are/);
  v.add({ name: 'a', kind: 'claude', value: A, owner: 'ben', share: 'anyone' });
  assert.throws(() => v.add({ name: 'a', kind: 'claude', value: B, owner: 'ben', share: 'anyone' }), /exists; rotate/);
  assert.throws(() => v.add({ name: 'a2', kind: 'claude', value: A, owner: 'ben', share: 'anyone' }), /already in the vault as a/);
  // No error message ever quotes a value.
  try {
    v.add({ name: 'z', kind: 'github', value: A, share: 'anyone' });
  } catch (e) {
    assert.ok(!(e as Error).message.includes(A.slice(13, 30)));
  }
});

test('vault: rotate, grant and remove; a rotated value is the one handed out', (t) => {
  const { make } = setup(t);
  const v = make();
  v.add({ name: 'a', kind: 'claude', value: A, owner: 'ben', share: 'anyone' });
  const r = v.rotate('a', B);
  assert.equal(r.fingerprint, fingerprintOf(B));
  assert.ok(r.rotatedAt);
  const run = { machineId: 'm3', role: 'workers' as const, userId: 'ben' };
  assert.equal(v.forRun(run, { claude: true }).claude?.token, B);
  const g = v.update('a', { machines: ['M5'], roles: ['standing'] });
  assert.deepEqual(g.machines, ['m5']);
  assert.equal(v.forRun(run, { claude: true }).claude, undefined, 'no longer granted to m3 workers');
  assert.equal(v.forRun({ machineId: 'm5', role: 'standing', userId: 'ben' }, { claude: true }).claude?.token, B);
  v.update('a', { disabled: true });
  assert.equal(v.forRun({ machineId: 'm5', role: 'standing', userId: 'ben' }, { claude: true }).claude, undefined, 'disabled');
  v.add({ name: 'shared-gh', kind: 'github', value: GH, share: 'anyone' });
  assert.throws(() => v.update('shared-gh', { share: 'owner' }), /needs an owner/);
  v.remove('shared-gh');
  v.remove('a');
  assert.deepEqual(v.list(), []);
  assert.throws(() => v.remove('a'), /no vault entry named a/);
});

test('vault: the key lives outside data/, readable by its owner only; a missing or wrong key hands nothing out', (t) => {
  const { dir, data, keyFile, make } = setup(t);
  assert.match(keySource({ dataDir: data, vault: { keyFile: path.join(data, 'k') } }).why ?? '', /inside the data folder/);
  assert.equal(keySource({ dataDir: data, vault: { keyFile } }).file, keyFile);
  assert.match(keySource({ dataDir: data }).why ?? '', /no vault key/);
  // The systemd credential wins over config.
  const creds = path.join(dir, 'creds');
  fs.mkdirSync(creds);
  fs.writeFileSync(path.join(creds, 'fff-vault-key'), newKeyText());
  assert.equal(keySource({ dataDir: data, vault: { keyFile } }, { CREDENTIALS_DIRECTORY: creds }).file, path.join(creds, 'fff-vault-key'));
  if (process.platform !== 'win32') {
    fs.chmodSync(keyFile, 0o644);
    assert.throws(() => readKey(keyFile), /readable by other users/);
    fs.chmodSync(keyFile, 0o600);
  }
  fs.writeFileSync(path.join(dir, 'short.key'), 'c2hvcnQ=\n', { mode: 0o600 });
  assert.throws(() => readKey(path.join(dir, 'short.key')), /not 32 bytes/);

  const v = make();
  v.add({ name: 'a', kind: 'claude', value: A, owner: 'ben', share: 'anyone' });
  v.add({ name: 'gh', kind: 'github', value: GH, share: 'anyone' });
  const none = make(() => ({ why: 'no vault key: test' }));
  assert.equal(none.status().key, 'missing');
  assert.deepEqual(none.list().map((e) => e.name), ['a', 'gh'], 'listing needs no key');
  const r = none.forRun({ machineId: 'm3', role: 'workers', userId: 'ben' }, { claude: true });
  assert.equal(r.claude, undefined);
  assert.deepEqual(r.env, {});
  assert.match(r.problems[0], /cannot open a, gh: no vault key/);
  assert.throws(() => none.add({ name: 'b', kind: 'claude', value: B, owner: 'ben', share: 'anyone' }), /cannot seal/);
  const other = path.join(dir, 'other.key');
  fs.writeFileSync(other, newKeyText(), { mode: 0o600 });
  fs.chmodSync(other, 0o600);
  const wrong = make(() => ({ file: other }));
  assert.equal(wrong.status().key, 'wrong');
  assert.equal(wrong.forRun({ machineId: 'm3', role: 'workers', userId: 'ben' }, { claude: true }).claude, undefined);
});

// systemd's credential file for a service that is not root: 0400, root-owned, the service user in a POSIX ACL; stat shows the ACL's
// mask in the group bits (0440). A hand-made file of that mode elsewhere is group-readable for real and stays refused (w736).
test('vault: systemd credential file (0440 by the ACL mask) opens, in the credentials folder only', { skip: process.platform === 'win32' }, (t) => {
  const { dir, data, keyFile, make } = setup(t);
  const creds = path.join(dir, 'creds');
  fs.mkdirSync(creds, { mode: 0o700 });
  fs.chmodSync(creds, 0o700);
  const cred = path.join(creds, 'fff-vault-key');
  fs.copyFileSync(keyFile, cred);
  fs.chmodSync(cred, 0o440);
  const me = process.getuid?.() ?? 0;
  // The path the portal takes: keySource marks the credential, the Vault passes that on.
  const src = keySource({ dataDir: data }, { CREDENTIALS_DIRECTORY: creds });
  assert.equal(src.file, cred);
  assert.equal(src.credentialsDir, creds);
  assert.equal(readKey(cred, { credentialsDir: creds }).length, 32);
  const v = make(() => src);
  assert.equal(v.status().key, 'loaded', v.status().why ?? '');
  v.add({ name: 'a', kind: 'claude', value: A, share: 'anyone' });
  assert.equal(v.forRun({ machineId: 'm3', role: 'workers' }, { claude: true }).claude?.token, A);

  // The same mode anywhere else is refused: through config vault.keyFile, and as a bare path.
  const loose = path.join(dir, 'etc', 'loose.key');
  fs.copyFileSync(keyFile, loose);
  fs.chmodSync(loose, 0o440);
  assert.match(make(() => keySource({ dataDir: data, vault: { keyFile: loose } }, {})).status().why ?? '', /readable by other users \(mode 440\)/);
  assert.throws(() => readKey(loose), /readable by other users/);
  assert.throws(() => readKey(cred), /readable by other users/, 'without the credentials folder named it is the strict rule');
  // A key file that merely sits in some other folder named as the credentials folder is not the credential.
  assert.throws(() => readKey(loose, { credentialsDir: creds }), /not directly in the credentials folder/);

  // Inside the credentials folder: other users, a write bit, a stranger as owner, an open folder, a link out are refused.
  for (const [mode, why] of [[0o444, /other users can access it/], [0o404, /other users can access it/], [0o460, /writable by a group or others/]] as const) {
    fs.chmodSync(cred, mode);
    assert.throws(() => readKey(cred, { credentialsDir: creds }), why, mode.toString(8));
  }
  fs.chmodSync(cred, 0o440);
  assert.throws(() => readKey(cred, { credentialsDir: creds, owners: [me + 1] }), /owned by uid/);
  fs.chmodSync(creds, 0o755);
  assert.throws(() => readKey(cred, { credentialsDir: creds }), /its folder is open to other users/);
  fs.chmodSync(creds, 0o750);
  assert.equal(readKey(cred, { credentialsDir: creds }).length, 32, 'group bits on the folder are the ACL mask too');
  fs.chmodSync(creds, 0o700);
  const out = path.join(creds, 'link');
  fs.symlinkSync(loose, out);
  assert.throws(() => readKey(out, { credentialsDir: creds }), /not directly in the credentials folder/);
  // A wrong key in the credential is still reported as the wrong key, and its content is never in a message.
  fs.chmodSync(cred, 0o600);
  fs.writeFileSync(cred, 'c2hvcnQ=');
  fs.chmodSync(cred, 0o440);
  assert.throws(() => readKey(cred, { credentialsDir: creds }), (e: Error) => /not 32 bytes/.test(e.message) && !e.message.includes('c2hvcnQ'));
});

test('vault: forRun gives the granted secrets as environment, and a Claude token only when asked', (t) => {
  const { make } = setup(t);
  const v = make();
  v.add({ name: 'a', kind: 'claude', value: A, owner: 'ben', share: 'anyone' });
  v.add({ name: 'gh', kind: 'github', value: GH, share: 'anyone', roles: ['workers'] });
  v.add({ name: 'max', kind: 'env', env: 'FFDISCORD_APP_TOKEN', value: DISCORD, share: 'anyone', machines: ['lothdesktop'] });
  const m3 = v.forRun({ machineId: 'm3', role: 'workers' }, { claude: false });
  assert.deepEqual(m3.env, { GH_TOKEN: GH });
  assert.equal(m3.claude, undefined);
  const loth = v.forRun({ machineId: 'lothdesktop', role: 'workers', userId: 'ben' }, { claude: true });
  assert.deepEqual(loth.env, { GH_TOKEN: GH, FFDISCORD_APP_TOKEN: DISCORD });
  assert.equal(loth.claude?.token, A);
  assert.deepEqual(v.forRun({ machineId: 'm3', role: 'standing' }, { claude: false }).env, {}, 'gh is for workers only');
  assert.deepEqual(v.claudeTokens().map((x) => x.label), [`vault: a …${A.slice(-4)}`]);
});

const usage = (session: number, weekly: number): PlanUsage => ({ available: true, asOf: '', models: [], session: { label: 's', percent: session }, weekly: { label: 'w', percent: weekly } });
const meta = (name: string, over: Partial<VaultEntryMeta> = {}): VaultEntryMeta => ({ id: name, name, kind: 'claude', share: 'anyone', roles: ['workers', 'standing'], machines: ['*'], fingerprint: name, last4: 'xxxx', createdAt: '', updatedAt: '', ...over });


test('eligible: role, machine and share', () => {
  const run = { machineId: 'm5', role: 'standing' as const, userId: 'Ben' };
  const gh = (over: Partial<VaultEntryMeta> = {}) => meta('a', { kind: 'github', ...over });
  assert.equal(eligible(gh(), run), true);
  assert.equal(eligible(gh({ roles: ['workers'] }), run), false);
  assert.equal(eligible(gh({ machines: ['m3'] }), run), false);
  assert.equal(eligible(gh({ machines: ['m3', 'M5'] }), run), true);
  // A Claude token serves only its owner (w739): shared and other people's tokens are in nobody's pool.
  assert.equal(eligible(meta('a'), run), false, 'a Claude token with no owner serves nobody');
  assert.equal(eligible(meta('a', { owner: 'ben' }), run), true);
  assert.equal(eligible(meta('a', { owner: 'loth', share: 'anyone' }), run), false, "another person's token, shared or not");
  assert.equal(eligible(meta('a', { owner: 'ben', roles: ['workers'] }), run), false, 'the standing role is not granted');
  // The ops worker takes the workers' grants on no machine; a person's orchestrator takes no grant at all.
  assert.equal(eligible(meta('a', { owner: 'ben', roles: ['workers'], machines: ['m3'] }), { ...run, role: 'ops' }), true);
  assert.equal(eligible(meta('a', { owner: 'ben', roles: [], machines: [] }), { ...run, role: 'orchestrator' }), true);
  assert.equal(eligible(meta('a', { owner: 'loth', roles: [], machines: [] }), { ...run, role: 'orchestrator' }), false);
  assert.equal(eligible(gh({ share: 'owner', owner: 'ben' }), run), true, 'user ids compare without case');
  assert.equal(eligible(gh({ share: 'owner', owner: 'loth' }), run), false);
  assert.equal(eligible(gh({ share: 'owner', owner: 'loth' }), { ...run, userId: undefined }), false);
  assert.equal(eligible(gh({ disabled: true }), run), false);
});

test('machineRunEnv: off by default; on, a vault token alone with the daemon credentials dropped; a person own token still wins', (t) => {
  const { make } = setup(t);
  const v = make();
  v.add({ name: 'shared', kind: 'claude', value: A, owner: 'ben', share: 'anyone' });
  v.add({ name: 'gh', kind: 'github', value: GH, share: 'anyone' });
  const problems: string[] = [];
  const ctx: VaultContext = { vault: v, payer: () => 'ben', onProblem: (l) => problems.push(l) };
  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: C, CLAUDE_CONFIG_DIR: '/x' }, userClaudeEnv: {}, machines: {} };
  const m = { id: 'm3' };

  // No context (the daemon, tests): exactly as before the vault.
  const before = machineRunEnv(cfg, m, { role: 'workers' }, undefined);
  assert.deepEqual(before, { env: { CLAUDE_CODE_OAUTH_TOKEN: C, CLAUDE_CONFIG_DIR: '/x' }, login: false, account: `host token …${C.slice(-4)}` });
  // A context, but machines.claudeFromVault off: the machine's account, plus the granted GitHub token.
  const off = machineRunEnv(cfg, m, { role: 'workers' }, ctx);
  assert.equal(off.env.CLAUDE_CODE_OAUTH_TOKEN, C);
  assert.equal(off.env.GH_TOKEN, GH);
  assert.equal(off.login, false);
  // On for m3: the vault token, the other credentials of claudeEnv dropped, login true (the daemon's own dropped too).
  const on = { ...cfg, machines: { claudeFromVault: { m3: true } } };
  assert.equal(claudeFromVault(on, m), true);
  assert.equal(claudeFromVault(on, { id: 'm5' }), false);
  const r = machineRunEnv(on, m, { role: 'workers', sessionId: 's1' }, ctx);
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, A);
  assert.equal(r.env.CLAUDE_CONFIG_DIR, '/x', 'non-credential settings stay');
  assert.equal(r.env.GH_TOKEN, GH);
  assert.equal(r.login, true);
  assert.match(r.account, /^vault token shared …/);
  // A person's own token (config userClaudeEnv) wins for their work, as before.
  const own = { ...on, userClaudeEnv: { loth: { CLAUDE_CODE_OAUTH_TOKEN: B } } };
  const lr = machineRunEnv(own, m, { role: 'workers', requestedBy: { userId: 'loth', displayName: 'Lothsahn' } }, ctx);
  assert.equal(lr.env.CLAUDE_CODE_OAUTH_TOKEN, B);
  assert.equal(lr.env.GH_TOKEN, GH);
  // Nothing eligible: back to the machine's account, and the fallback is reported.
  v.update('shared', { machines: ['m5'] });
  const fb = machineRunEnv(on, m, { role: 'workers' }, ctx);
  assert.equal(fb.env.CLAUDE_CODE_OAUTH_TOKEN, C);
  assert.match(problems.at(-1) ?? '', /no vault Claude token for a workers run on m3 for ben; it runs on host token/);
  assert.ok(!problems.join('\n').includes(A.slice(13, 30)), 'problems never hold a value');
});

test('config: machines.claudeFromVault is checked like useHostClaudeEnv', () => {
  checkAccountConfig({ machines: { claudeFromVault: { m3: true, '*': false } } });
  assert.throws(() => checkAccountConfig({ machines: { claudeFromVault: 'yes' as never } }), /machines\.claudeFromVault is true, false/);
  assert.throws(() => checkAccountConfig({ machines: { claudeFromVault: { m3: 'on' as never } } }), /claudeFromVault\.m3 is true or false/);
});

test('redaction: GitHub tokens by pattern, and every vault value by value', () => {
  assert.equal(redactSecrets(`push with ${GH} now`), `push with ghp_[redacted …${GH.slice(-4)}] now`);
  const pat = ['github', '_pat_', 'X'.repeat(40)].join('');
  assert.equal(redactSecrets(pat), `github_pat_[redacted …XXXX]`);
  registerSecretValues([DISCORD, 'short']);
  try {
    assert.equal(redactSecrets(`env: ${DISCORD}.`), `env: [redacted vault secret …${DISCORD.slice(-4)}].`);
    assert.equal(redactSecrets('short stays'), 'short stays', 'values under 8 characters are not learned');
  } finally {
    registerSecretValues([]);
  }
  assert.equal(redactSecrets(`env: ${DISCORD}.`), `env: ${DISCORD}.`);
});

test('githubCredentialEnv: a helper for github.com that reads GH_TOKEN, after the config entries already there', () => {
  assert.deepEqual(githubCredentialEnv({ GIT_CONFIG_COUNT: '3' }), {
    GIT_CONFIG_KEY_3: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_3: '',
    GIT_CONFIG_KEY_4: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_4: GITHUB_HELPER,
    GIT_CONFIG_COUNT: '5',
  });
  assert.equal(githubCredentialEnv({}).GIT_CONFIG_COUNT, '2');
  assert.ok(!GITHUB_HELPER.includes('ghp_'), 'the helper holds no token, only the variable name');
});

test('githubCredentialEnv: git really asks the helper and gets GH_TOKEN', { skip: spawnSync('git', ['--version']).status !== 0 }, () => {
  const env = { ...process.env, GH_TOKEN: GH, GIT_TERMINAL_PROMPT: '0', ...githubCredentialEnv({}) };
  const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /username=x-access-token/);
  assert.ok(r.stdout.includes(`password=${GH}`));
});

test('machine credentials: issued once as a hash, revoked by id', (t) => {
  const { data } = setup(t);
  const tok = issueMachineToken(data, 'm3');
  assert.match(tok, /^ffm_m3_[A-Za-z0-9_-]{43}$/);
  assert.ok(!fs.readFileSync(path.join(data, 'machine-tokens.json'), 'utf8').includes(tok.slice(7)), 'only the hash is kept');
  assert.deepEqual(enrolledMachines(data), ['m3']);
  assert.equal(revokeMachineToken(data, 'm3'), true);
  assert.equal(revokeMachineToken(data, 'm3'), false);
  assert.deepEqual(enrolledMachines(data), []);
  assert.throws(() => issueMachineToken(data, 'M 3'), /lower-case/);
});

test('vaultStatusLine: counts and the key, never a value', (t) => {
  const { make } = setup(t);
  const v = make();
  v.add({ name: 'a', kind: 'claude', value: A, owner: 'ben', share: 'anyone' });
  v.add({ name: 'gh', kind: 'github', value: GH, share: 'anyone' });
  const line = vaultStatusLine(v, ['m3']) ?? '';
  assert.match(line, /2 entries \(1 claude, 1 github\); key loaded; Claude tokens from it on m3/);
  assert.ok(!line.includes(A.slice(13, 30)) && !line.includes(GH.slice(4, 20)));
});

test('vaultCli: add from a file, list, grant, machine credentials; no value on stdout', (t) => {
  const { dir, data, keyFile } = setup(t);
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ dataDir: data, sandboxRoot: path.join(dir, 'sb'), repo: { url: 'https://example.test/g.git', basePath: path.join(dir, 'base') }, unity: { editorPath: 'x' } }));
  const env = { ...process.env, FFSB_CONFIG: cfgFile, FFF_VAULT_KEY_FILE: keyFile };
  const cli = (...a: string[]) => spawnSync(process.execPath, ['server/vaultCli.ts', ...a], { env, encoding: 'utf8' });
  const tf = path.join(dir, 'token');
  fs.writeFileSync(tf, `${A}\n`);
  const add = cli('add', '--name', 'ben-max', '--kind', 'claude', '--owner', 'ben', '--file', tf);
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /added: ben-max/);
  assert.equal(cli('add', '--name', 'x', '--kind', 'claude', '--owner', 'ben', A).status, 2, 'never from the command line');
  const ls = cli('list');
  assert.match(ls.stdout, /key: loaded/);
  assert.match(ls.stdout, new RegExp(`ben-max .*…${A.slice(-4)}  ${fingerprintOf(A)}  owner ben; workers,standing on \\*`));
  assert.equal(cli('grant', 'ben-max', '--machines', 'm3,m5', '--roles', 'workers').status, 0);
  assert.match(cli('list').stdout, /workers on m3,m5/);
  const out = path.join(dir, 'm3.cred');
  const issued = cli('machine-credential', 'issue', 'm3', '--out', out);
  assert.equal(issued.status, 0, issued.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /^ffm_m3_/);
  assert.match(cli('machine-credential', 'list').stdout, /m3/);
  assert.equal(cli('machine-credential', 'revoke', 'm3').status, 0);
  for (const r of [add, ls, issued]) assert.ok(!r.stdout.includes(A.slice(13, 40)) && !r.stdout.includes(fs.readFileSync(out, 'utf8').trim().slice(7)));
});

test('the usage meters show each vault Claude token as its own account, with where it is granted', (t) => {
  const { make } = setup(t);
  const v = make();
  v.add({ name: 'ben-max', kind: 'claude', value: A, owner: 'ben', machines: ['m3'] });
  const [tok] = v.claudeTokens();
  assert.equal(tok.where, "the token vault: workers, standing on m3, ben's own work");
  const key = `token:${tok.fingerprint}`;
  const entries = new Map([[key, { kind: 'token' as const, label: tok.label, usage: usage(30, 40), direct: true }]]);
  const accounts = buildAccounts(entries, { hostName: 'vm', machines: [{ id: 'm3', usesToken: false }], vault: [{ key, label: tok.label, where: tok.where }], sessions: [{ id: 's1', source: key, live: true }] });
  const a = accounts.find((x) => x.id === key);
  assert.ok(a, 'listed');
  assert.equal(a.label, `vault: ben-max …${A.slice(-4)}`);
  assert.deepEqual(a.where, [tok.where]);
  assert.deepEqual(a.sessionIds, ['s1']);
  assert.equal(a.usage?.weekly?.percent, 40);
});

test('addSecretValues: a daemon learns the secret values of a launch spec without forgetting the vault ones', () => {
  try {
    registerSecretValues([DISCORD]);
    const spec = { GH_TOKEN: GH, FFDISCORD_APP_TOKEN: 'x'.repeat(12), FF_SESSION_ID: 'session-123456' };
    addSecretValues(Object.entries(spec).filter(([k]) => SECRET_ENV.test(k)).map(([, v]) => v));
    assert.equal(redactSecrets(`${DISCORD} ${'x'.repeat(12)} session-123456`), `[redacted vault secret …${DISCORD.slice(-4)}] [redacted vault secret …xxxx] session-123456`);
  } finally {
    registerSecretValues([]);
  }
});

test('vault: after a new key, the entries sealed with the old one are named, and rotating each makes it usable again', (t) => {
  const { dir, make } = setup(t);
  make().add({ name: 'a', kind: 'claude', value: A, owner: 'ben', share: 'anyone' });
  make().add({ name: 'gh', kind: 'github', value: GH, share: 'anyone' });
  const other = path.join(dir, 'new.key');
  fs.writeFileSync(other, newKeyText(), { mode: 0o600 });
  fs.chmodSync(other, 0o600);
  const v = make(() => ({ file: other }));
  assert.equal(v.status().key, 'wrong');
  const r = v.forRun({ machineId: 'm3', role: 'workers', userId: 'ben' }, { claude: true });
  assert.equal(r.claude, undefined);
  assert.deepEqual(r.env, {});
  assert.match(r.problems.join('\n'), /gh does not open with this key \(rotate it\)/);
  v.rotate('a', B);
  const half = v.status();
  assert.equal(half.key, 'loaded');
  assert.match(half.why ?? '', /sealed with another key, rotate: gh/);
  assert.equal(v.forRun({ machineId: 'm3', role: 'workers', userId: 'ben' }, { claude: true }).claude?.token, B);
  v.add({ name: 'c', kind: 'claude', value: C, owner: 'ben', share: 'anyone' });
  v.remove('gh');
  assert.equal(v.status().why, undefined, 'every entry opens again');
});

test('vault: one value per variable, the run person own entry first, then by name; a name that looks like an id opens nothing else', (t) => {
  const { make } = setup(t);
  const v = make();
  v.add({ name: 'shared-gh', kind: 'github', value: ghTok('s'), share: 'anyone' });
  v.add({ name: 'ben-gh', kind: 'github', value: ghTok('b'), owner: 'ben', share: 'owner' });
  v.add({ name: 'a-gh', kind: 'github', value: ghTok('a'), share: 'anyone' });
  assert.equal(v.forRun({ machineId: 'm3', role: 'workers', userId: 'ben' }, { claude: false }).env.GH_TOKEN, ghTok('b'), "ben's own");
  assert.equal(v.forRun({ machineId: 'm3', role: 'workers', userId: 'loth' }, { claude: false }).env.GH_TOKEN, ghTok('a'), 'then by name');
  // An entry named like another's id: grants are looked up by id, never by that name.
  const owned = v.add({ name: 'x', kind: 'claude', value: A, owner: 'loth', share: 'owner' });
  v.add({ name: owned.id, kind: 'claude', value: B, owner: 'ben', share: 'anyone', machines: ['m9'] });
  assert.equal(v.forRun({ machineId: 'm3', role: 'workers', userId: 'loth' }, { claude: true }).claude?.token, A);
  assert.equal(v.forRun({ machineId: 'm9', role: 'workers', userId: 'ben' }, { claude: true }).claude?.token, B);
});

test("whose tokens: nobody's work by where it came from (lothsahn's defaults), an operator's own, configurable", () => {
  const src = (kind: string) => ({ kind, untrusted: true }) as never;
  assert.deepEqual(UNATTRIBUTED_DEFAULTS, { intake: 'lothsahn', ffbox: 'lothsahn', nightly: 'ben' });
  assert.equal(unattributedKind({ unattributed: true, source: src('discord-bug') }), 'intake');
  assert.equal(unattributedKind({ unattributed: true, source: src('release') }), 'intake');
  assert.equal(unattributedKind({ unattributed: true, source: src('ffbox-request') }), 'ffbox');
  assert.equal(unattributedKind({ unattributed: true, source: src('nightly') }), 'nightly');
  assert.equal(unattributedKind({ delegation: { id: 'd', agentId: NIGHTLY_SENTRY, agentName: 'Nightly sentry', auto: true } }), 'nightly', "the sentry's delegations");
  assert.equal(unattributedKind({ source: src('ffbox-request') }), undefined, 'an FFBox request naming an operator is theirs');
  assert.equal(unattributedKind({}), undefined, "a person's own request");
  assert.equal(tokenPersonForWork({}, { unattributed: true, source: src('ffbox-diagnosis') }), 'lothsahn');
  assert.equal(tokenPersonForWork({ vault: { unattributed: { ffbox: 'ben' } } }, { unattributed: true, source: src('ffbox-diagnosis') }), 'ben');
  assert.equal(tokenPersonForWork({}, undefined), undefined);
  assert.equal(unattributedPerson({}, 'nightly'), 'ben');
});

test('config: vault.unattributed names a portal user per kind of work', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-vcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const base = { dataDir: path.join(dir, 'data'), sandboxRoot: path.join(dir, 'sb'), repo: { url: 'https://example.test/g.git', basePath: path.join(dir, 'b') }, unity: { editorPath: 'x' } };
  const before = process.env.FFSB_CONFIG;
  process.env.FFSB_CONFIG = file;
  t.after(() => (before === undefined ? delete process.env.FFSB_CONFIG : (process.env.FFSB_CONFIG = before)));
  fs.writeFileSync(file, JSON.stringify({ ...base, vault: { unattributed: { intake: 'lothsahn', nightly: 'ben' } } }));
  assert.deepEqual(loadConfig().vault?.unattributed, { intake: 'lothsahn', nightly: 'ben' });
  fs.writeFileSync(file, JSON.stringify({ ...base, vault: { unattributed: { players: 'x' } } }));
  assert.throws(() => loadConfig(), /vault\.unattributed\.players: no such kind of work/);
  fs.writeFileSync(file, JSON.stringify({ ...base, vault: { unattributed: { intake: 'not a user' } } }));
  assert.throws(() => loadConfig(), /vault\.unattributed\.intake is a portal user id/);
});

test("machineRunEnv per person: each person's own Claude and GitHub tokens, never another's; nobody's work on the configured person's", (t) => {
  const { make } = setup(t);
  const v = make();
  v.add({ name: 'host-ben-claude', kind: 'claude', value: A, owner: 'ben', share: 'owner' });
  v.add({ name: 'host-ben-github', kind: 'github', value: ghTok('b'), owner: 'ben', share: 'owner' });
  v.add({ name: 'host-lothsahn-claude', kind: 'claude', value: B, owner: 'lothsahn', share: 'owner' });
  v.add({ name: 'host-lothsahn-github', kind: 'github', value: ghTok('l'), owner: 'lothsahn', share: 'owner' });
  const ctx: VaultContext = { vault: v, payer: () => 'ben' };
  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: C }, userClaudeEnv: {}, machines: { claudeFromVault: true } };
  const m = { id: 'm3' };
  const loth = { userId: 'lothsahn', displayName: 'Lothsahn' };
  const r1 = machineRunEnv(cfg, m, { role: 'workers', requestedBy: loth }, ctx);
  assert.deepEqual([r1.env.CLAUDE_CODE_OAUTH_TOKEN, r1.env.GH_TOKEN], [B, ghTok('l')], "lothsahn's request: his");
  const r2 = machineRunEnv(cfg, m, { role: 'workers', requestedBy: { userId: 'ben', displayName: 'Ben' } }, ctx);
  assert.deepEqual([r2.env.CLAUDE_CODE_OAUTH_TOKEN, r2.env.GH_TOKEN], [A, ghTok('b')], "Ben's request: his");
  const r3 = machineRunEnv(cfg, m, { role: 'workers' }, ctx);
  assert.deepEqual([r3.env.CLAUDE_CODE_OAUTH_TOKEN, r3.env.GH_TOKEN], [A, ghTok('b')], "no requester: the system payer's");
  const r4 = machineRunEnv(cfg, m, { role: 'workers', requestedBy: { userId: 'ben', displayName: 'Ben' }, tokenUser: 'lothsahn' }, ctx);
  assert.deepEqual([r4.env.CLAUDE_CODE_OAUTH_TOKEN, r4.env.GH_TOKEN], [B, ghTok('l')], "intake work billed to Ben runs on lothsahn's tokens");
  // Someone with no token of their own gets nobody else's: the machine's own account, as before the vault.
  const r5 = machineRunEnv(cfg, m, { role: 'workers', requestedBy: { userId: 'mate', displayName: 'Mate' } }, ctx);
  assert.deepEqual([r5.env.CLAUDE_CODE_OAUTH_TOKEN, r5.env.GH_TOKEN], [C, undefined]);
});
