import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FFFCTL_FORMS, OPS_FFFCTL, OPS_PATHS, checkOpsShell } from './opsWorker.ts';

/**
 * The orchestration worker may run every read-only part of every fffctl command (Lothsahn, 2026-10-09, w745: "anytime a new
 * fffctl command is provided, all read only parts of it should be allowed by the orchestrator worker"). These tests read
 * fffctl and the scripts behind it and fail when a command or form exists that FFFCTL_FORMS (server/opsWorker.ts) does not
 * classify as allowed or changing, so a new one cannot land unclassified; they also check the server guard and
 * fff-ops-priv (the root wrapper) agree with the table. No token value appears here: only command words.
 */

const read = { platform: 'linux' as const, home: OPS_PATHS.home, cwd: OPS_PATHS.scratch, fsx: { realpath: () => undefined } };
const shell = (cmd: string) => checkOpsShell(cmd, read);
// CRLF checkouts (Windows runners): the patterns below read LF.
const file = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fffctl = file('deploy/vm/guest/fffctl');
const priv = file('deploy/vm/guest/fff-ops-priv');

/** The labels of the `case` block that starts at `start` (a regex on its first line) in `text`, at `indent`. */
function labels(text: string, start: RegExp, indent: string): string[] {
  const m = start.exec(text);
  assert.ok(m, `no ${start} in the source`);
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(new RegExp(`^${indent.slice(0, -2)}esac`, 'm'));
  const out: string[] = [];
  for (const line of rest.slice(0, end).split('\n')) {
    const l = new RegExp(`^${indent}([A-Za-z-][A-Za-z0-9 |_-]*)\\)`).exec(line);
    if (l) out.push(...l[1].split('|').map((x) => x.trim()));
  }
  return out;
}
const firstWord = (f: string) => f.split(' ')[0];
const formsOf = (cmd: string) => [...new Set([...FFFCTL_FORMS[cmd].allowed, ...FFFCTL_FORMS[cmd].changes].map(firstWord))];

/** Each command's own form words, read from its source. */
const discovered: Record<string, string[]> = {
  watchdog: labels(fffctl, /^cmd_watchdog\(\) \{\n.*\n  case \$what in\n/m, '    ').filter((x) => x !== '*'),
  vault: [
    ...labels(fffctl, /^cmd_vault\(\) \{\n  case "\$\{1:-list\}" in\n/m, '    ').filter((x) => x !== '*' && !x.startsWith('-')),
    ...[...file('server/vaultCli.ts').matchAll(/^\s+case '([a-z-]+)':/gm)].map((m) => m[1]),
    ...[...file('server/vaultCli.ts').matchAll(/^if \(cmd === '([a-z-]+)'\)/gm)].map((m) => m[1]).filter((x) => x !== 'machine-credential'),
  ],
  'machine-credential': [...file('server/vaultCli.ts').matchAll(/sub === '([a-z-]+)'/g)].map((m) => m[1]),
  migrate: [...file('scripts/fff-migrate.ts').matchAll(/'(--[a-z-]+)': '[a-z-]+'/g)].map((m) => m[1]).concat(file('scripts/fff-migrate.ts').includes("case '--help'") ? ['--help'] : []),
};

test('every fffctl command is classified: the table and fffctl list the same commands', () => {
  const real = labels(fffctl, /^case "\$\{1:-status\}" in\n/m, '  ').filter((x) => /^[a-z]/.test(x));
  assert.deepEqual([...new Set(real)].sort(), Object.keys(FFFCTL_FORMS).sort(), 'a new fffctl command goes in FFFCTL_FORMS (server/opsWorker.ts) with its read-only forms allowed, and in fff-ops-priv, in the same PR');
});

test('every form of the commands that have forms is classified: allowed (read only) or changes', () => {
  for (const [cmd, found] of Object.entries(discovered)) {
    assert.ok(found.length > 0, `found no forms of ${cmd} in its source`);
    assert.deepEqual([...new Set(found)].sort(), formsOf(cmd).sort(), `${cmd}: a new form belongs in FFFCTL_FORMS.${cmd}, allowed when it changes nothing and prints no secret`);
  }
});

test('the table: a form is either allowed or changing, never both; no vault form that writes or copies the key is allowed', () => {
  for (const [cmd, f] of Object.entries(FFFCTL_FORMS)) {
    for (const a of f.allowed) assert.ok(!f.changes.includes(a), `${cmd} ${a}`);
  }
  for (const w of ['init', 'export-key', 'add', 'add-claude', 'put', 'rotate', 'grant', 'remove', 'export', 'new-key']) assert.ok(FFFCTL_FORMS.vault.changes.includes(w) && !FFFCTL_FORMS.vault.allowed.some((a) => firstWord(a) === w), `vault ${w}`);
  assert.deepEqual(FFFCTL_FORMS.watchdog.allowed, [], 'every watchdog form runs, pauses, resumes or resets: none is read only');
});

test("the server's guard lets through every allowed form and refuses every changing one", () => {
  for (const [cmd, f] of Object.entries(FFFCTL_FORMS)) {
    if (!OPS_FFFCTL.includes(cmd)) {
      assert.match(shell(`fffctl ${cmd}`) ?? '', /a person's/, `fffctl ${cmd}`);
      continue;
    }
    for (const a of f.allowed) assert.equal(shell(`fffctl ${cmd} ${a === 'N' ? '300' : a}`.trim()), undefined, `fffctl ${cmd} ${a}`);
    if (['vault', 'machine-credential', 'migrate'].includes(cmd)) {
      for (const c of f.changes) assert.match(shell(`fffctl ${cmd} ${c}`) ?? '', /a person's/, `fffctl ${cmd} ${c}`);
    }
  }
});

test('fff-ops-priv has a case for exactly the commands the guard lets through, and refuses the rest', () => {
  const main = priv.slice(priv.indexOf('case "${1:-help}" in'));
  const real = labels(main, /^case "\$\{1:-help\}" in\n/m, '  ').filter((x) => /^[a-z]/.test(x));
  assert.deepEqual([...new Set(real)].sort(), [...new Set(OPS_FFFCTL)].sort(), 'the guard (OPS_FFFCTL) and fff-ops-priv disagree');
  for (const [cmd, f] of Object.entries(FFFCTL_FORMS)) if (!OPS_FFFCTL.includes(cmd)) assert.ok(!real.includes(cmd), `fff-ops-priv has a case for ${cmd}, which is a person's`);
  // The wrapper pins the vault's forms in its source: list, list --names, help, and nothing that changes it.
  for (const w of FFFCTL_FORMS.vault.changes) assert.ok(!new RegExp(`^\\s+${w}\\)`, 'm').test(main), `fff-ops-priv has a ${w} case`);
});
