import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { FFBOX_HASH_FILE, OLD_TOKEN_FILE, ffboxTokenHash, inlineSecrets, migrateConfig, readableConfigFiles, retireOldTokenFile, secretsDirOf } from './configMigration.ts';
import { setAppConfig } from './appConfig.ts';
import { fakeToken } from './testVault.ts';

/**
 * w1078: config.json holds no secret. lothsahn: "Delete claudeTokenFile and its associated config. Also delete claudeEnv,
 * get rid of the fallback mode, everything runs off the vault", and "migrate providers.ffbox { enabled, tokenSha256 } to a
 * file in the secrets folder and have the config reference the filename". The start does it once, keeps the file as it was
 * in the secrets folder, and scrubs the saved versions. Every token here is a fake built in the test.
 */

const HASH = createHash('sha256').update('w1078-fake-connector-token').digest('hex');

/** A portal laid out like the VM's: <root>/config/config.json and <root>/secrets. */
function portal(t: { after: (fn: () => void) => void }, raw: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-config-w1078-'));
  const config = path.join(root, 'config', 'config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const full = { sandboxRoot: path.join(root, 'sb'), dataDir: path.join(root, 'data'), repo: { url: 'https://example.test/game.git', basePath: path.join(root, 'base') }, ...raw };
  fs.writeFileSync(config, JSON.stringify(full, null, 2) + '\n', { mode: 0o600 });
  const before = { config: process.env.FFSB_CONFIG, secrets: process.env.FFSB_SECRETS_DIR };
  process.env.FFSB_CONFIG = config;
  delete process.env.FFSB_SECRETS_DIR;
  t.after(() => {
    for (const [k, v] of [['FFSB_CONFIG', before.config], ['FFSB_SECRETS_DIR', before.secrets]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, config, secrets: path.join(root, 'secrets'), data: path.join(root, 'data') };
}

/** The live config's secret-bearing shape before w1078 (fakes). */
const OLD = {
  ownerName: 'Ben',
  claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken('host'), CLAUDE_CONFIG_DIR: '/srv/fff/home/.claude' },
  userClaudeEnv: { lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken('lothsahn') } },
  claudeTokenFile: '/srv/fff/secrets/claude-oauth-token',
  claudeAccounts: { orchestrator: 'tokenfile', dispatcher: 'vault:vault-lothsahn-1' },
  machines: { useHostClaudeEnv: { '*': true, m3: false }, claudeFromVault: true, githubFromVault: true },
  providers: { ffbox: { enabled: true, tokenSha256: HASH } },
  intake: { nightly: { run: { enabled: true, time: '03:00' } } },
};

const mode = (f: string) => fs.statSync(f).mode & 0o777;

test('the start splits config.json once: retired Claude keys out, the FFBox hash into its file, the old file kept in the secrets folder (w1078)', (t) => {
  const p = portal(t, OLD);
  const original = fs.readFileSync(p.config, 'utf8');
  assert.equal(secretsDirOf(p.config), p.secrets, "the VM's layout: secrets beside config's folder");
  assert.equal(secretsDirOf('/tmp/ffsb-x/config.json', '/srv/app'), '/tmp/ffsb-x/secrets', 'a config in any other folder keeps its secrets inside it, never in a shared /tmp/secrets');
  assert.equal(secretsDirOf('/srv/app/config.json', '/srv/app'), '/srv/app/secrets');
  const m = migrateConfig(p.config, p.secrets, new Date('2026-10-12T04:00:00Z'));
  const said = m.changes.join('; ');
  for (const k of ['claudeEnv', 'userClaudeEnv', 'claudeTokenFile', 'machines.useHostClaudeEnv', 'machines.claudeFromVault', 'claudeAccounts.orchestrator', 'providers.ffbox.tokenSha256']) assert.match(said, new RegExp(k.replace('.', '\\.')), k);
  // Names and last four characters only: no token and no hash is ever said.
  for (const secret of [fakeToken('host'), fakeToken('lothsahn'), HASH]) assert.ok(!said.includes(secret) && !said.includes(secret.slice(0, 20)), 'a secret was said');
  assert.match(said, /CLAUDE_CONFIG_DIR/, 'claudeEnv names its other variables, which go with it');

  const cfg = JSON.parse(fs.readFileSync(p.config, 'utf8'));
  assert.deepEqual(inlineSecrets(cfg), [], 'config.json holds no secret');
  assert.equal(cfg.claudeEnv, undefined);
  assert.equal(cfg.userClaudeEnv, undefined);
  assert.equal(cfg.claudeTokenFile, undefined);
  assert.deepEqual(cfg.machines, { githubFromVault: true });
  assert.deepEqual(cfg.claudeAccounts, { orchestrator: 'vault', dispatcher: 'vault:vault-lothsahn-1' }, 'the orchestrators stay on "vault" written out (a rollback reads it), the pinned dispatcher stays');
  assert.deepEqual(cfg.providers.ffbox, { enabled: true, tokenSha256File: path.join(p.secrets, FFBOX_HASH_FILE) });
  assert.deepEqual(cfg.intake, OLD.intake, 'every other setting as it was');
  assert.equal(mode(p.config), 0o600, "config.json keeps its mode");

  const hashFile = path.join(p.secrets, FFBOX_HASH_FILE);
  assert.equal(fs.readFileSync(hashFile, 'utf8'), `${HASH}\n`);
  assert.equal(mode(hashFile), 0o600);
  assert.ok(m.backup && m.backup.startsWith(p.secrets + path.sep), 'the backup is in the secrets folder');
  assert.equal(fs.readFileSync(m.backup!, 'utf8'), original, 'the backup is the file as it was');
  assert.equal(mode(m.backup!), 0o600);

  // Once: a second start changes nothing and keeps no second backup.
  const after = fs.readFileSync(p.config, 'utf8');
  const again = migrateConfig(p.config, p.secrets);
  assert.deepEqual(again.changes, []);
  assert.equal(again.backup, undefined);
  assert.equal(fs.readFileSync(p.config, 'utf8'), after);
  assert.equal(fs.readdirSync(p.secrets).filter((n) => n.startsWith('config.json.before-w1078')).length, 1);
});

test("config.json's saved versions keep no secret: rewritten, or moved into the secrets folder when they cannot be read (w1078)", (t) => {
  const p = portal(t, OLD);
  const text = fs.readFileSync(p.config, 'utf8');
  fs.writeFileSync(`${p.config}.prev`, text);
  fs.writeFileSync(`${p.config}.1`, text);
  fs.writeFileSync(`${p.config}.2`, text.slice(0, text.length / 2), { mode: 0o600 }); // torn by a crash, with a token in it
  fs.writeFileSync(`${p.config}.3`, JSON.stringify({ ownerName: 'Ben' }));
  const m = migrateConfig(p.config, p.secrets);
  assert.deepEqual(m.scrubbed.sort(), ['config.json.1', 'config.json.2 (moved to the secrets folder)', 'config.json.3', 'config.json.prev']);
  for (const n of ['.prev', '.1']) assert.deepEqual(inlineSecrets(JSON.parse(fs.readFileSync(`${p.config}${n}`, 'utf8'))), [], n);
  assert.ok(!fs.existsSync(`${p.config}.2`), 'the torn version left the config folder');
  assert.ok(fs.existsSync(path.join(p.secrets, 'config.json.2.before-w1078')));
  assert.deepEqual(readableConfigFiles(p.config).map((f) => path.basename(f)), ['config.json', 'config.json.prev', 'config.json.1', 'config.json.3']);
});

test('a config that still holds a secret is not readable, and its key path is named, never its value (w1078)', (t) => {
  const p = portal(t, { ownerName: 'Ben' });
  assert.deepEqual(readableConfigFiles(p.config), [p.config]);
  const raw = JSON.parse(fs.readFileSync(p.config, 'utf8'));
  raw.repo.url = 'https://someone:hunter2-fake@example.test/game.git';
  raw.publicGitIdentity = { name: 'X', email: 'x@example.test', repos: [`https://x-access-token:${'ghp_'}${'f'.repeat(36)}@github.com/a/b.git`] };
  fs.writeFileSync(p.config, JSON.stringify(raw));
  const m = migrateConfig(p.config, p.secrets);
  assert.deepEqual(m.changes, ['claudeAccounts.orchestrator ("vault", written out)'], 'the credentials are not moved: they are a person\'s to fix');
  assert.deepEqual(m.warnings, ['repo.url', 'publicGitIdentity.repos.0']);
  assert.deepEqual(readableConfigFiles(p.config), []);
  assert.deepEqual(inlineSecrets({ claudeTokenFile: '/x', providers: { ffbox: { tokenSha256: HASH } } }), ['claudeTokenFile', 'providers.ffbox.tokenSha256']);
});

test('the accounts a release before w1078 also reads: the orchestrators "vault" written out, the dispatcher only a pin (w1078)', (t) => {
  const p = portal(t, { claudeAccounts: { dispatcher: 'vault' } });
  migrateConfig(p.config, p.secrets);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.config, 'utf8')).claudeAccounts, { orchestrator: 'vault' }, 'a dispatcher "vault" is the payer\'s pool: no key (older releases refused it)');
  const q = portal(t, { claudeAccounts: { orchestrator: 'login', dispatcher: 'tokenfile' } });
  const m = migrateConfig(q.config, q.secrets);
  assert.deepEqual(JSON.parse(fs.readFileSync(q.config, 'utf8')).claudeAccounts, { orchestrator: 'vault' });
  assert.deepEqual(m.changes, ['claudeAccounts.orchestrator ("login" -> "vault")', 'claudeAccounts.dispatcher ("tokenfile")']);
});

test('config loading: the split config loads and the connector hash comes from its file; an unsplit one (a dry run) loads too, its retired keys ignored (w1078)', (t) => {
  const p = portal(t, OLD);
  const unsplit = loadConfig();
  assert.equal((unsplit as unknown as Record<string, unknown>).claudeEnv, undefined, 'claudeEnv is retired: never in the running config');
  assert.equal((unsplit as unknown as Record<string, unknown>).userClaudeEnv, undefined);
  assert.deepEqual(unsplit.claudeAccounts, { dispatcher: 'vault:vault-lothsahn-1' }, '"tokenfile" is dropped: the orchestrators run on their pools');
  assert.equal(ffboxTokenHash(unsplit), HASH, 'before the split, the inline hash still lets the connector in');
  assert.ok(unsplit.retiredKeys?.includes('claudeEnv'));

  migrateConfig(p.config, p.secrets);
  const cfg = loadConfig();
  assert.equal(cfg.providers?.ffbox?.tokenSha256, undefined);
  assert.equal(cfg.providers?.ffbox?.tokenSha256File, path.join(p.secrets, FFBOX_HASH_FILE));
  assert.equal(ffboxTokenHash(cfg), HASH);
  assert.deepEqual(cfg.retiredKeys, []);
  // A new hash applies without a restart; a file that holds no hash lets nobody in.
  const other = createHash('sha256').update('another-fake').digest('hex');
  fs.writeFileSync(cfg.providers!.ffbox!.tokenSha256File!, other);
  assert.equal(ffboxTokenHash(cfg), other);
  fs.writeFileSync(cfg.providers!.ffbox!.tokenSha256File!, 'not a hash');
  assert.equal(ffboxTokenHash(cfg), undefined);
});

test('set_app_config providers.ffbox.token writes only its hash, to the file in the secrets folder; config.json names the file and never holds the hash (w1078)', (t) => {
  const p = portal(t, { providers: { ffbox: { enabled: true } } });
  const cfg = loadConfig();
  const token = `ffpv1_${'A'.repeat(43)}`;
  const r = setAppConfig(p.config, cfg, 'providers.ffbox.token', token);
  assert.equal(r.before, 'not set');
  assert.match(String(r.after), /^set \(…[0-9a-f]{4}\)$/);
  const file = path.join(p.secrets, FFBOX_HASH_FILE);
  const want = createHash('sha256').update(token).digest('hex');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), want);
  assert.equal(mode(file), 0o600);
  const text = fs.readFileSync(p.config, 'utf8');
  assert.ok(!text.includes(want) && !text.includes(token), 'config.json holds neither the token nor its hash');
  assert.equal(JSON.parse(text).providers.ffbox.tokenSha256File, file);
  assert.equal(ffboxTokenHash(cfg), want, 'live');
  // A second token: the file changes, config.json does not.
  const before = fs.readFileSync(p.config, 'utf8');
  setAppConfig(p.config, cfg, 'providers.ffbox.token', `ffpv1_${'B'.repeat(43)}`);
  assert.equal(fs.readFileSync(p.config, 'utf8'), before);
  // null removes the file and the key: the connector is refused.
  setAppConfig(p.config, cfg, 'providers.ffbox.token', null);
  assert.ok(!fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(p.config, 'utf8')).providers.ffbox.tokenSha256File, undefined);
  assert.equal(ffboxTokenHash(cfg), undefined);
});

test('the retired Claude token file is deleted only once the deploy verified and the dispatcher runs on a vault token, with no copy (w1078)', (t) => {
  const p = portal(t, { ownerName: 'Ben' });
  const sha = 'abc123def4567890abc123def4567890abc12345';
  const o = { configFile: p.config, secretsDir: p.secrets, dataDir: p.data, sha, dispatcherOnVault: true };
  assert.deepEqual(retireOldTokenFile(o), {}, 'no file: nothing to do');
  fs.mkdirSync(p.secrets, { recursive: true });
  const file = path.join(p.secrets, OLD_TOKEN_FILE);
  fs.writeFileSync(file, `${fakeToken('old')}\n`, { mode: 0o600 });
  assert.match(retireOldTokenFile(o).waiting ?? '', /not verified/);
  fs.mkdirSync(p.data, { recursive: true });
  fs.writeFileSync(path.join(p.data, 'update.verified.json'), JSON.stringify({ sha: 'ffff000', previous: 'x' }));
  assert.match(retireOldTokenFile(o).waiting ?? '', /not verified/, 'another commit verified');
  fs.writeFileSync(path.join(p.data, 'update.verified.done.json'), JSON.stringify({ sha: sha.slice(0, 12) }));
  assert.match(retireOldTokenFile({ ...o, dispatcherOnVault: false }).waiting ?? '', /dispatcher/);
  const raw = JSON.parse(fs.readFileSync(p.config, 'utf8'));
  fs.writeFileSync(p.config, JSON.stringify({ ...raw, claudeTokenFile: file }));
  assert.match(retireOldTokenFile(o).waiting ?? '', /claudeTokenFile/, 'not while config still names it');
  fs.writeFileSync(p.config, JSON.stringify(raw));
  assert.deepEqual(retireOldTokenFile(o), { deleted: file });
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(fs.readdirSync(p.secrets), [], 'no copy kept anywhere (lothsahn: "let\'s delete it")');
});
