import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOG_SOURCES, LOG_SOURCE_NAMES, PAGE_MAX_CHARS, journalReader, readPortalLogs, redactLogText, stillLooksSecret, unsafeRegex, type JournalReader, type PortalLogsDeps } from './portalLogs.ts';
import { CATALOG } from './launch.ts';
import { registerSecretValues } from './secrets.ts';

/** portal_logs (w920, docs/portal-logs.md): workers read the portal's logs, read-only, redacted before they are filtered. */

const NOW = Date.parse('2026-10-10T20:00:00Z');

/** Built from pieces, so no scanner (gitleaks) mistakes a fixture for a leaked key. */
const FAKE = {
  oat: ['sk-ant', 'oat01', 'A'.repeat(50)].join('-'),
  ort: ['sk-ant', 'ort01', 'B'.repeat(50)].join('-'),
  gh: ['ghp', 'c'.repeat(36)].join('_'),
  machine: ['ffm', 'm5', 'd'.repeat(40)].join('_'),
  jwt: ['eyJ' + 'h'.repeat(20), 'p'.repeat(20), 's'.repeat(20)].join('.'),
  bearer: 'q'.repeat(30),
  password: 'hunter2hunter2',
  cookie: 'sid=' + 'z'.repeat(24),
};

function tmpData(t: { after: (f: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function deps(dataDir: string, journal?: JournalReader, machines: { id: string; local: boolean }[] = [{ id: 'm5', local: false }, { id: 'beast', local: true }]): PortalLogsDeps {
  return {
    dataDir,
    journal: journal ?? (async () => ({ lines: [] })),
    machine: (id) => machines.find((m) => m.id === id),
    machineIds: () => machines.map((m) => m.id),
    now: () => NOW,
  };
}

const journalOf = (lines: string[], note?: string): JournalReader => async () => ({ lines, ...(note ? { note } : {}) });
/** The text between the ~~~ fences. */
const body = (out: string) => out.split('~~~text\n')[1]?.split('\n~~~')[0] ?? '';

/** A tree's names, sizes and times, so "nothing was written" is a comparison. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const f = path.join(d, n);
      const st = fs.lstatSync(f);
      out.push(`${path.relative(dir, f)} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(f);
    }
  };
  walk(dir);
  return out;
}

test('w920: every secret form is masked, and ordinary lines stay', () => {
  registerSecretValues([]);
  const cases: [string, string][] = [
    [`GET /x Authorization: Bearer ${FAKE.bearer}`, FAKE.bearer],
    [`{"headers":{"authorization":"Basic ${FAKE.bearer}"}}`, FAKE.bearer],
    [`Proxy-Authorization: ${FAKE.bearer}`, FAKE.bearer],
    [`sent Set-Cookie: ${FAKE.cookie}; Path=/`, FAKE.cookie],
    [`cookie=${FAKE.cookie}`, FAKE.cookie],
    [`git clone https://x-access-token:${FAKE.bearer}@github.com/a/b.git`, FAKE.bearer],
    [`remote https://${'u'.repeat(30)}@github.com/a/b`, 'u'.repeat(30)],
    [`fetch https://h.example/cb?code=1&access_token=${FAKE.bearer}&x=2`, FAKE.bearer],
    [`password=${FAKE.password} user=ben`, FAKE.password],
    [`{"token": "${FAKE.password}"}`, FAKE.password],
    [`x-api-key: ${FAKE.password}`, FAKE.password],
    [`{"claudeAiOauth":{"accessToken":"${FAKE.oat}","refreshToken":"${FAKE.ort}"}}`, FAKE.ort],
    [`oauth ${FAKE.oat}`, FAKE.oat],
    [`token ${FAKE.gh} used`, FAKE.gh],
    [`credential ${FAKE.machine}`, 'd'.repeat(40)],
    [`session ${FAKE.jwt}`, FAKE.jwt],
    [['-----BEGIN OPENSSH', 'PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH', 'PRIVATE KEY-----'].join(' '), 'b3BlbnNzaC1rZXktdjEAAAAA'],
  ];
  for (const [line, secret] of cases) {
    const out = redactLogText(line);
    assert.ok(!out.includes(secret), `still there: ${line} -> ${out}`);
    assert.ok(!stillLooksSecret(out), `still looks secret: ${out}`);
  }
  // A value the vault holds goes by value, whatever its form.
  registerSecretValues(['plain-env-api-key-value']);
  assert.ok(!redactLogText('using plain-env-api-key-value now').includes('plain-env-api-key-value'));
  registerSecretValues([]);
  // What a person needs to read stays.
  const keep = [
    'fff-update[812]: building 590e1332a1b7c0d6 (origin/main) in /srv/fff/app/releases/590e13329a1b',
    'GET https://fff.example/api/health 200 in 4 ms from 100.64.0.7',
    'git remote ssh://git@github.com/Final-Factory/ff-factory.git',
    'tokens used: 123456 (input 100000)',
    'update.verified.json written: {"sha":"590e1332a1b7c0d6e8f1a2b3c4d5e6f708192a3b"}',
  ];
  for (const l of keep) assert.equal(redactLogText(l), l);
});

test('w920: a pattern never sees a secret, and a line that still looks like one is left out', async (t) => {
  const lines = [`2026-10-10T19:59:00+0000 vm fff-portal[1]: refreshed with ${FAKE.oat}`, `2026-10-10T19:58:00+0000 vm fff-portal[1]: header Authorization: Bearer ${FAKE.bearer}`, `2026-10-10T19:57:00+0000 vm fff-portal[1]: odd token ghp_${'e'.repeat(22)} in a log`, '2026-10-10T19:56:00+0000 vm fff-portal[1]: an ordinary line'];
  const d = deps(tmpData(t), journalOf(lines));
  // grep for the secret itself finds nothing: it is gone before the match.
  for (const probe of [FAKE.oat, FAKE.bearer, FAKE.oat.slice(0, 30)]) {
    const out = await readPortalLogs(d, { source: 'portal', grep: probe });
    assert.match(out, /0 line\(s\) of 0 matching/, probe);
  }
  assert.match(await readPortalLogs(d, { source: 'portal', regex: 'sk-ant-oat01-A+' }), /0 line\(s\) of 0 matching/);
  const all = await readPortalLogs(d, { source: 'portal' });
  assert.ok(!all.includes(FAKE.oat) && !all.includes(FAKE.bearer) && !all.includes('e'.repeat(22)), all);
  assert.match(all, /an ordinary line/);
  assert.match(all, /refreshed with sk-ant-oat01-\[redacted/);
  assert.match(all, /Authorization: Bearer \[redacted\]/);
  assert.match(all, /1 line\(s\) left out: they still looked like a secret/);
});

test('w920: only the listed sources are read: another name, a path or a link is refused', async (t) => {
  const dataDir = tmpData(t);
  const outside = tmpData(t);
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ token: FAKE.oat }));
  fs.writeFileSync(path.join(dataDir, 'send-queue.json'), `queued ${FAKE.password}`);
  fs.mkdirSync(path.join(dataDir, 'cleanup', 'm5'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'cleanup-log.jsonl'), JSON.stringify({ at: '2026-10-10T19:00:00Z', trigger: 'hourly', removed: 0, softFreeGB: 20 }) + '\n');
  fs.symlinkSync(path.join(outside, 'cleanup-log.jsonl'), path.join(dataDir, 'cleanup', 'm5', 'cleanup-log.jsonl'));
  fs.symlinkSync(path.join(dataDir, 'state.json'), path.join(dataDir, 'update.result.json'));
  const d = deps(dataDir);
  for (const source of ['state.json', '../state.json', 'send-queue', 'send-queue.json', 'vault', 'logins', 'sessions', 'uploads', 'transcripts', '/etc/passwd', 'C:\\x', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'JOURNAL', 'journal ']) {
    await assert.rejects(readPortalLogs(d, { source }), /is not one portal_logs reads/, source);
  }
  // A machine id is not a path.
  for (const machine of ['..', '../..', 'm5/../..', '/etc', 'm5\\..\\..', 'nope', '']) {
    if (machine === '') continue;
    await assert.rejects(readPortalLogs(d, { source: 'cleanup', machine }), /machine: /, machine);
  }
  await assert.rejects(readPortalLogs(d, { source: 'portal', machine: 'm5' }), /only the cleanup source takes one/);
  // A link in the data folder is not followed, to a file in or outside it.
  await assert.rejects(readPortalLogs(d, { source: 'cleanup', machine: 'm5' }), /a link: refused/);
  await assert.rejects(readPortalLogs(d, { source: 'update_result' }), /a link: refused/);
  // The list names no closed file.
  const list = await readPortalLogs(d, {});
  for (const name of LOG_SOURCE_NAMES) assert.ok(list.includes(`- ${name}:`), name);
  assert.doesNotMatch(list, /state\.json|send-queue|vault\.|uploads|sessions\.json/);
  assert.deepEqual(Object.values(LOG_SOURCES).filter((s) => s.kind === 'doc').map((s) => (s as { file: string }).file).sort(), ['auto-deploy.json', 'machine-rollout.json', 'unit-watchdog.json', 'update.prepared.json', 'update.result.json', 'update.verified.json', 'update.verifying.json']);
});

test('w920: the journal is paged, windowed and filtered', async (t) => {
  const lines = Array.from({ length: 50 }, (_, i) => `2026-10-10T19:${String(59 - i).padStart(2, '0')}:00+0000 vm fff-portal[1]: line ${i}${i % 10 === 0 ? ' restart requested' : ''}`);
  let asked: Parameters<JournalReader>[0] | undefined;
  const d = deps(tmpData(t), async (q) => {
    asked = q;
    return { lines };
  });
  const first = await readPortalLogs(d, { source: 'journal', limit: 20 });
  assert.deepEqual(asked?.units, ['fff-portal.service', 'fff-update.service', 'fff-health.service']);
  assert.equal(asked!.untilMs, NOW);
  assert.equal(asked!.sinceMs, NOW - 3_600_000, 'the default window is the last hour');
  assert.match(first, /20 line\(s\) of 50 matching, newest first, offset 0; more: offset 20 for the next page; 50 line\(s\) read/);
  assert.match(first, /last hour/);
  assert.equal(body(first).split('\n')[0], lines[0]);
  const next = await readPortalLogs(d, { source: 'journal', limit: 20, offset: 20 });
  assert.equal(body(next).split('\n')[0], lines[20]);
  const last = await readPortalLogs(d, { source: 'journal', limit: 20, offset: 40 });
  assert.match(last, /10 line\(s\) of 50 matching[^.]*no more in this window/);
  // grep (any case) and regex
  const g = await readPortalLogs(d, { source: 'updater', grep: 'RESTART REQUESTED' });
  assert.deepEqual(asked?.units, ['fff-update.service']);
  assert.equal(body(g).split('\n').length, 5);
  const r = await readPortalLogs(d, { source: 'health', regex: 'line (3|4)$' });
  assert.deepEqual(body(r).split('\n').map((l) => l.slice(-6)), ['line 3', 'line 4']);
  // since and until reach the reader, and are checked
  await readPortalLogs(d, { source: 'portal', since: '2026-10-09T00:00:00Z', until: '2026-10-09T06:00:00+02:00' });
  assert.equal(asked!.sinceMs, Date.parse('2026-10-09T00:00:00Z'));
  assert.equal(asked!.untilMs, Date.parse('2026-10-09T04:00:00Z'));
  await assert.rejects(readPortalLogs(d, { source: 'portal', since: 'yesterday' }), /since: an ISO time with a zone/);
  await assert.rejects(readPortalLogs(d, { source: 'portal', until: '2026-10-09T00:00:00' }), /until: an ISO time with a zone/);
  await assert.rejects(readPortalLogs(d, { source: 'portal', since: '2026-10-10T00:00:00Z', until: '2026-10-09T00:00:00Z' }), /since is after until/);
  // limits are clamped, not trusted
  assert.match(await readPortalLogs(d, { source: 'portal', limit: 99999 }), /50 line\(s\) of 50/);
  assert.match(await readPortalLogs(d, { source: 'portal', limit: -5, offset: -5 }), /1 line\(s\) of 50 matching, newest first, offset 0/);
});

test('w1420: the journal of tailscaled is a source of its own (Funnel, control reconnects, Drop lines), its login links masked', async (t) => {
  const login = ['https://login.tailscale.com/a', 'a1b2c3d4e5f6'].join('/');
  const lines = [
    '2026-10-17T00:10:39+0000 fff tailscaled[760119]: Drop: TCP{[fd7a:115c:a1e0:ab12:4843:cd96:625f:d761]:21980 > [fd7a:115c:a1e0::5a34:ac62]:59343} 80 no rules matched',
    '2026-10-17T00:10:01+0000 fff tailscaled[760119]: control: netmap: got new dial plan from control',
    '2026-10-17T00:09:58+0000 fff tailscaled[760119]: Received error: PollNetMap: read tcp 10.213.41.10:48312->192.200.0.103:443: read: connection reset by peer',
    `2026-10-17T00:09:00+0000 fff tailscaled[760119]: To authenticate, visit: ${login}`,
  ];
  let asked: Parameters<JournalReader>[0] | undefined;
  const d = deps(tmpData(t), async (q) => {
    asked = q;
    return { lines };
  });
  const out = await readPortalLogs(d, { source: 'tailscaled', regex: 'PollNetMap|dial plan|visit' });
  assert.deepEqual(asked?.units, ['tailscaled.service']);
  assert.match(out, /tailscaled \(tailscaled\.service\)/);
  assert.deepEqual(body(out).split('\n').map((l) => l.replace(/^.*\]: /, '')), [
    'control: netmap: got new dial plan from control',
    'Received error: PollNetMap: read tcp 10.213.41.10:48312->192.200.0.103:443: read: connection reset by peer',
    'To authenticate, visit: https://login.tailscale.com/a/[redacted]',
  ]);
  assert.ok(!out.includes('a1b2c3d4e5f6'), 'a login link reached the answer');
  assert.ok(LOG_SOURCES.tailscaled, 'tailscaled is listed');
});

test('w920: a page stops at its size cap, a window that holds more says so, and a journal that cannot be read says why', async (t) => {
  const fat = Array.from({ length: 200 }, (_, i) => `${i} ${'x'.repeat(990)}`);
  const d = deps(tmpData(t), journalOf(fat));
  const out = await readPortalLogs(d, { source: 'portal', limit: 2000 });
  assert.ok(body(out).length <= PAGE_MAX_CHARS, `${body(out).length}`);
  assert.match(out, /more: offset \d+ for the next page/);
  assert.ok(body(out).split('\n').every((l) => l.length <= 1000));
  const capped = await readPortalLogs(deps(tmpData(t), journalOf(Array.from({ length: 20_000 }, (_, i) => `l${i}`))), { source: 'portal', limit: 1 });
  assert.match(capped, /20000 line\(s\) read \(the window holds more: narrow it/);
  const nope = await readPortalLogs(deps(tmpData(t), journalOf([], "the portal's account cannot read the journal")), { source: 'portal' });
  assert.match(nope, /0 line\(s\) of 0 matching[^.]*account cannot read the journal/);
});

test('w920: a regex that could run away is refused', () => {
  for (const bad of ['(a+)+$', '(.*)*x', '(a|b)+c', '(a)\\1', '(?=x)y', '(?<!x)y', '(?<name>a)\\k<name>', 'x'.repeat(101), '[a-']) assert.ok(unsafeRegex(bad), bad);
  for (const ok of ['restart (requested|done)', 'update\\.result', '^2026-10-1\\d', 'ERROR|WARN', 'a{2,3}b']) assert.equal(unsafeRegex(ok), undefined, ok);
});

test('w920: the clean-up log of a machine, of the host, and the rotated half, newest first', async (t) => {
  const dataDir = tmpData(t);
  const pass = (at: string, extra: object = {}) => JSON.stringify({ at, trigger: 'hourly', removed: 1, freedBytes: 3 * 1024 ** 3, softFreeGB: 20, ...extra }) + '\n';
  fs.mkdirSync(path.join(dataDir, 'cleanup', 'm5'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'cleanup', 'm5', 'cleanup-log.jsonl.1'), pass('2026-10-08T10:00:00Z', { removedAll: [{ path: '/Users/b/ffw/tmp/old', bytes: 5 * 1024 ** 3, rule: 'tmp' }] }));
  fs.writeFileSync(
    path.join(dataDir, 'cleanup', 'm5', 'cleanup-log.jsonl'),
    pass('2026-10-10T09:00:00Z', { removedAll: [{ path: '/Users/b/ffw/tmp/ffa-abc', bytes: 2 * 1024 ** 3, rule: 'agent-temp', why: 'session ended 12 min ago' }], listed: [{ path: '/Users/b/ffw/sandboxes/slot9/x', bytes: 1024 ** 3, why: 'not attributable to a request' }] }) +
      'not json at all\n' +
      pass('2026-10-10T10:00:00Z', { removed: 0, dryRun: true, planned: [{ path: '/Users/b/ffw/tmp/ffa-def', bytes: 1024 ** 3, rule: 'agent-temp', why: 'dry run' }] }),
  );
  fs.writeFileSync(path.join(dataDir, 'cleanup-log.jsonl'), pass('2026-10-10T11:00:00Z', { trigger: 'low-space' }));
  const d = deps(dataDir);
  const m5 = body(await readPortalLogs(d, { source: 'cleanup', machine: 'm5' })).split('\n');
  assert.match(m5[0], /^\[2026-10-10T10:00:00Z\] .*dry run/);
  assert.ok(m5.some((l) => /^\[2026-10-10T10:00:00Z\] would remove: \/Users\/b\/ffw\/tmp\/ffa-def {2}1\.0 GB {2}\(dry run\)/.test(l)), m5.join('\n'));
  assert.ok(m5.some((l) => /^\[2026-10-10T09:00:00Z\] removed: \/Users\/b\/ffw\/tmp\/ffa-abc {2}2\.0 GB {2}\(session ended 12 min ago\)/.test(l)));
  assert.ok(m5.some((l) => /^\[2026-10-10T09:00:00Z\] kept for a person: .*slot9\/x/.test(l)));
  assert.ok(m5.some((l) => /^\[2026-10-08T10:00:00Z\] removed: .*tmp\/old {2}5\.0 GB {2}\(tmp\)/.test(l)), 'the rotated half is read too');
  assert.ok(m5.findIndex((l) => l.startsWith('[2026-10-10T10')) < m5.findIndex((l) => l.startsWith('[2026-10-08T10')), 'newest first');
  // since narrows by the pass's time; grep finds an item
  const since = body(await readPortalLogs(d, { source: 'cleanup', machine: 'm5', since: '2026-10-10T00:00:00Z' }));
  assert.doesNotMatch(since, /2026-10-08/);
  assert.equal(body(await readPortalLogs(d, { source: 'cleanup', machine: 'm5', grep: 'slot9' })).split('\n').length, 1);
  // No machine, or the machine that is the host: the host's own log in data/.
  assert.match(body(await readPortalLogs(d, { source: 'cleanup' })), /^\[2026-10-10T11:00:00Z\]/);
  assert.match(body(await readPortalLogs(d, { source: 'cleanup', machine: 'beast' })), /^\[2026-10-10T11:00:00Z\]/);
  // A machine with no log yet says so.
  assert.match(await readPortalLogs(deps(dataDir, undefined, [{ id: 'm3', local: false }]), { source: 'cleanup', machine: 'm3' }), /no clean-up log for m3 yet/);
});

test('w920: the update files are shown whole, pretty, redacted, and a missing one says so', async (t) => {
  const dataDir = tmpData(t);
  fs.writeFileSync(path.join(dataDir, 'update.result.json'), JSON.stringify({ ok: false, at: '2026-10-10T19:00:00Z', error: `npm ci failed: https://u:${FAKE.password}@registry.example/x`, headBefore: 'aaa', headAfter: 'aaa' }));
  fs.writeFileSync(path.join(dataDir, 'unit-watchdog.json'), JSON.stringify({ schema: 1, units: [{ unit: 'fff-portal.service', active: 'active' }], events: [{ at: '2026-10-10T18:00:00Z', unit: 'tailscaled.service', what: 'restarted: inactive' }] }));
  const d = deps(dataDir);
  const r = await readPortalLogs(d, { source: 'update_result' });
  assert.match(r, /update\.result\.json: \d+ line\(s\) of \d+ matching, in order/);
  assert.match(body(r), /"ok": false/);
  assert.match(body(r), /npm ci failed: https:\/\/u:\[redacted\]@registry\.example\/x/);
  assert.ok(!r.includes(FAKE.password));
  assert.match(body(await readPortalLogs(d, { source: 'unit_watchdog', grep: 'tailscaled' })), /"unit": "tailscaled\.service"/);
  assert.match(await readPortalLogs(d, { source: 'machine_rollout' }), /machine-rollout\.json is not there/);
  assert.match(await readPortalLogs(d, { source: 'update_verified', since: '2026-10-01T00:00:00Z' }), /is not there/);
  // The list says which are there now.
  const list = await readPortalLogs(d, {});
  assert.match(list, /- update_result: .*\[there now, \d+ bytes/);
  assert.match(list, /- machine_rollout: .*\[not there now\]/);
});

test('w920: reading changes nothing, and the module has no way to write', async (t) => {
  const dataDir = tmpData(t);
  fs.mkdirSync(path.join(dataDir, 'cleanup', 'm5'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'cleanup', 'm5', 'cleanup-log.jsonl'), JSON.stringify({ at: '2026-10-10T09:00:00Z', trigger: 'hourly', removed: 0, softFreeGB: 20 }) + '\n');
  fs.writeFileSync(path.join(dataDir, 'update.result.json'), '{"ok":true}');
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{"machines":[]}');
  const before = snapshot(dataDir);
  const d = deps(dataDir, journalOf(['a line']));
  for (const input of [{}, { source: 'journal' }, { source: 'cleanup', machine: 'm5' }, { source: 'update_result' }, { source: 'unit_watchdog' }, { source: 'cleanup', grep: 'x' }]) await readPortalLogs(d, input);
  for (const source of ['state.json', '../x']) await assert.rejects(readPortalLogs(d, { source }));
  assert.deepEqual(snapshot(dataDir), before, 'the data folder is as it was');
  // The tool takes no argument that names a path or a value to store.
  assert.deepEqual(Object.keys(CATALOG.portal_logs).sort(), ['grep', 'limit', 'machine', 'offset', 'regex', 'since', 'source', 'until']);
  // The source has no write call, no shell and exactly one command: journalctl.
  const src = fs.readFileSync(new URL('./portalLogs.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\b(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rmSync|rmdir|rename|renameSync|mkdir|mkdirSync|copyFile|truncate|createWriteStream|chmod|chown|symlink|utimes|ftruncate|writeSync|execSync|spawnSync|exec|spawn|execFile|fork)\b\s*\(/);
  assert.doesNotMatch(src, /openSync\([^)]*,\s*'[^r]/, 'files are opened to read');
  assert.deepEqual([...src.matchAll(/\brun\(\s*'([^']+)'/g)].map((m) => m[1]), ['journalctl']);
});

test('w920: the real journal reader runs journalctl with fixed arguments, and says why when it cannot', async (t) => {
  const bin = tmpData(t);
  const argsFile = path.join(bin, 'args.txt');
  const write = (script: string) => {
    fs.writeFileSync(path.join(bin, 'journalctl'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  };
  const q = { units: ['fff-portal.service', 'fff-update.service'], sinceMs: Date.parse('2026-10-10T19:00:00Z'), untilMs: Date.parse('2026-10-10T20:00:00Z'), max: 500 };
  const oldPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  if (process.platform !== 'win32') {
    write(`echo "$@" > '${argsFile}'\nprintf -- '-- Journal begins at x --\\nline two\\nline one\\n'`);
    const ok = await journalReader('linux')(q);
    assert.deepEqual(ok.lines, ['line two', 'line one']);
    assert.equal(fs.readFileSync(argsFile, 'utf8').trim(), '--no-pager -r -o short-iso -n 500 -u fff-portal.service -u fff-update.service --since 2026-10-10 19:00:00 UTC --until 2026-10-10 20:00:00 UTC');
    write(`echo 'Hint: You are currently not seeing messages from other users and the system.' >&2\necho '-- No entries --'`);
    assert.match((await journalReader('linux')(q)).note ?? '', /cannot read the journal.*systemd-journal group/);
    write(`echo "Failed to parse timestamp: ${FAKE.bearer}" >&2\nexit 1`);
    assert.match((await journalReader('linux')(q)).note ?? '', /journalctl failed \(exit 1\)/);
  }
  assert.match((await journalReader('win32')(q)).note ?? '', /does not run under systemd/);
});
