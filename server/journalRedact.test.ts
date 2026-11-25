import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_LINE_WITHHELD, redactLogLines } from './logRedact.ts';
import { registerSecretValues } from './secrets.ts';
import { Vault, VAULT_FILE, newKeyText } from './vault.ts';

// w5525 (security audit w5452, finding 16): the portal's console output reached the journal unredacted, and `fffctl logs`
// masked it with a sed that knew a few shapes. Now every write to stdout and stderr goes through redactLogLines
// (server/journalRedact.ts), and fffctl logs pipes the journal through server/redactLogsCli.ts. Fakes built at run time.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const KEY_KIND = ['PRIVATE', 'KEY'].join(' ');
const FAKES = {
  discord: `${'MTA'.repeat(8)}.GaBcDe.${'FaKe_'.repeat(6)}yVC9`,
  pem: `-----BEGIN ${KEY_KIND}-----\nMIIEfakefakefake${'FaKe'.repeat(8)}\nfakefake+/=\n-----END ${KEY_KIND}-----`,
  jwt: `${b64url('{"alg":"HS256"}')}.${b64url('{"sub":"fake-user-1"}')}.${'FaKeSiG_'.repeat(4)}yVC9`,
  bearer: `fake0${'AbCd'.repeat(6)}yVC9`,
  urlPass: 'hunter2-fake-pass-9',
  vault: 'plain-vault-value-w5525',
};
/** What must never reach the journal: each fake, or its private-key body. */
const leaks = (text: string) => [...Object.values(FAKES).filter((v) => !v.startsWith('-----')), 'MIIEfakefake'].filter((s) => text.includes(s));

test('w5525: every console call and direct write of the portal reaches the journal redacted, each missed shape included', () => {
  // A child portal-like process: turns the redactor on as server/index.ts does (first import), then prints each shape
  // through every route a module of the portal could use.
  const child = `
    import './server/journalRedactStart.ts';
    const { registerSecretValues } = await import('./server/secrets.ts');
    const s = JSON.parse(process.env.W5525_FAKES);
    registerSecretValues([s.vault]);
    console.log('discord login with', s.discord);
    console.info(\`jwt=\${s.jwt}\`);
    console.warn('github: request with Authorization: Bearer ' + s.bearer);
    console.error(new Error('git clone https://ben:' + s.urlPass + '@github.com/Final-Factory/x.git failed'));
    console.debug('%s', 'agent printed ' + s.pem);
    console.log({ env: { SOME_SETTING: s.vault } });
    console.trace('trace ' + s.vault);
    process.stdout.write('direct stdout vault ' + s.vault + '\\n');
    process.stderr.write(Buffer.from('direct stderr buffer ' + s.jwt + '\\n'));
    process.stdout.write('plain line kept 590e1332a1b7c0d6e8f1a2b3c4d5e6f708192a3b https://github.com/a/b/pull/1\\n', () => {});
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, W5525_FAKES: JSON.stringify(FAKES) },
  });
  assert.equal(r.status, 0, `child failed: ${r.stderr.slice(-400)}`);
  const out = r.stdout + r.stderr;
  assert.deepEqual(leaks(out), []);
  // every line was written, masked rather than dropped
  for (const m of ['discord login with', 'jwt=', 'Authorization: Bearer [redacted', 'https://ben:[redacted]@github.com', 'agent printed', 'SOME_SETTING', 'trace', 'direct stdout vault', 'direct stderr buffer [redacted JWT']) {
    assert.ok(out.includes(m), `missing: ${m}`);
  }
  assert.ok(out.includes('plain line kept 590e1332a1b7c0d6e8f1a2b3c4d5e6f708192a3b https://github.com/a/b/pull/1'), 'an ordinary line was changed');
});

const runCli = (input: string, env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ['server/redactLogsCli.ts'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, input, env: { ...process.env, FFSB_CONFIG: '', ...env } });

const journalOf = (lines: string[]) => lines.map((l, i) => `2026-11-20T10:00:0${i % 10}+0000 fff node[812]: ${l}`).join('\n') + '\n';

test('w5525: fffctl logs: the journal, old entries included, comes out redacted the same way', () => {
  const lines = [
    `discord login with ${FAKES.discord}`,
    `jwt=${FAKES.jwt}`,
    `Authorization: Bearer ${FAKES.bearer}`,
    `git clone https://ben:${FAKES.urlPass}@github.com/x.git failed`,
    `-----BEGIN ${KEY_KIND}-----`,
    'MIIEfakefakefake' + 'FaKe'.repeat(8),
    `-----END ${KEY_KIND}-----`,
    'sandbox slot1 started; PR https://github.com/Final-Factory/ff-factory/pull/1 at 590e1332a1b7',
  ];
  const r = runCli(journalOf(lines));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(leaks(r.stdout), []);
  const out = r.stdout.split('\n');
  assert.equal(out.length, lines.length + 1, 'a line was dropped or added');
  // the same masks portal_logs shows, line by line
  for (const i of [0, 1, 2, 3]) assert.equal(out[i], journalOf([redactLogLines(lines[i])]).trimEnd().replace(':00+', `:0${i}+`));
  // the journal keeps a printed key's lines as separate entries: BEGIN to END all withheld
  assert.deepEqual(out.slice(4, 7), [KEY_LINE_WITHHELD, KEY_LINE_WITHHELD, KEY_LINE_WITHHELD]);
  assert.match(out[7], /fff node\[812\]: sandbox slot1 started; PR https:\/\/github\.com\/Final-Factory\/ff-factory\/pull\/1 at 590e1332a1b7$/, 'an ordinary line was changed');
  assert.equal(r.stderr, 'redact-logs: no FFSB_CONFIG: token shapes and log forms only\n');
});

test("w5525: fffctl logs masks the vault's values, opened with the key file fff-ops-priv names", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-redact-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'vault.key');
  fs.writeFileSync(keyFile, newKeyText(), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ repo: { basePath: path.join(dir, 'repo') }, dataDir, sandboxRoot: path.join(dir, 'sandboxes'), machines: {} }));
  new Vault({ file: path.join(dataDir, VAULT_FILE), key: () => ({ file: keyFile }) }).add({ name: 'w5525-fake', kind: 'env', env: 'W5525_FAKE_SECRET', value: FAKES.vault, owner: 'ben', share: 'owner' });

  const r = runCli(journalOf([`printed the setting ${FAKES.vault} by mistake`]), { FFSB_CONFIG: config, FFF_VAULT_KEY_FILE: keyFile });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(leaks(r.stdout), []);
  assert.ok(r.stdout.endsWith('printed the setting [redacted vault secret …5525] by mistake\n'), r.stdout.slice(-60));
  assert.equal(r.stderr, '');
});

test('w5525: the cost per line', (t) => {
  // What the portal prints: request and session lines, JSON bits, URLs, ids; one line in fifty with a secret shape. With
  // fifty vault values registered, as a portal holds.
  registerSecretValues(Array.from({ length: 50 }, (_, i) => `fake-vault-value-${i}-${'x'.repeat(i % 20)}`));
  t.after(() => registerSecretValues([]));
  const typical = [
    'sessions: w5525 slot1 (lothdesktop) turn 14 ended: 18,402 tokens in, 1,233 out, 41 s',
    'ffm: lothdesktop heartbeat ok; 2 sandboxes busy, editor slot1@00c40dc1 up',
    '{"level":"info","msg":"ci poll","pr":"Final-Factory/ff-factory#1152","head":"590e1332a1b7c0d6e8f1a2b3c4d5e6f708192a3b","state":"pending"}',
    'GET https://api.github.com/repos/Final-Factory/FinalFactory/pulls/4328 200 in 312 ms',
    'scheduler: w5526 queued behind w5480 on lothdesktop (unity 3/3)',
    'secrets: redacted 0 secret(s) in the sessions and work items held',
    'Error: fetch failed\n    at node:internal/deps/undici/undici:13510:13\n    at async ghApi (file:///srv/fff/app/current/server/github.ts:88:15)',
  ];
  const secret = [`Authorization: Bearer ${FAKES.bearer}`, `token ${FAKES.jwt}`, `https://ben:${FAKES.urlPass}@x.example/`];
  const lines: string[] = [];
  for (let i = 0; i < 20_000; i++) lines.push(i % 50 === 49 ? secret[i % 3] : typical[i % typical.length]);
  for (const l of lines.slice(0, 500)) redactLogLines(l); // warm the regular expressions
  const t0 = process.hrtime.bigint();
  let kept = 0;
  for (const l of lines) kept += redactLogLines(l).length;
  const us = Number(process.hrtime.bigint() - t0) / 1000 / lines.length;
  t.diagnostic(`redactLogLines: ${us.toFixed(2)} µs per line over ${lines.length} lines (${kept} chars out)`);
  // A bound for a slow CI runner, not a benchmark: the portal prints a few lines a second.
  assert.ok(us < 200, `${us.toFixed(2)} µs per line`);
});
