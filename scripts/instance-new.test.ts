import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type NewOptions,
  addToList,
  briefs,
  checkConfig,
  configFor,
  githubRepo,
  launchDomain,
  listEntry,
  listFromTaskArgs,
  msysPath,
  nextSteps,
  parseOptions,
  plist,
  refusals,
  startScript,
  taskScript,
} from './instance/new.ts';
import { listProblem, readList, settingsDiff } from './instance/update-all.ts';

// A folder of this computer's kind, so the portal's own loadConfig takes its paths (it refuses F:/ paths off Windows).
const DIR = path.join(os.tmpdir(), 'ff-instance-new-test', 'atlas');
const fwd = (p: string) => p.replace(/\\/g, '/');

const opts = (o: Partial<NewOptions> = {}): NewOptions => ({
  name: 'atlas',
  project: 'Atlas Mapper',
  repo: 'https://github.com/someone/atlas-mapper.git',
  port: 8893,
  dir: DIR,
  machines: ['beast', 'm3'],
  owner: 'Ben',
  payer: 'ben',
  from: process.cwd(),
  dryRun: false,
  ...o,
});

test('configFor: Lens Scout\'s settings with this instance\'s folders, which the portal\'s loadConfig takes', () => {
  const c = configFor(opts()) as any;
  checkConfig(c);
  const at = (...p: string[]) => [fwd(DIR), ...p].join('/');
  assert.equal(c.port, 8893);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.trustProxy, false, 'no public URL: the default (true) is turned off');
  assert.equal(c.publicUrl, undefined);
  assert.equal(c.ownerName, 'Ben');
  assert.equal(c.systemPayer, 'ben');
  assert.equal(c.dataDir, at('data'));
  assert.equal(c.sandboxRoot, at('host-sandboxes'));
  assert.equal(c.standingRoot, at('agents'));
  assert.deepEqual(c.repo, { url: 'https://github.com/someone/atlas-mapper.git', basePath: at('base') });
  assert.equal(c.defaultBase, 'origin/main');
  assert.equal(c.vault.keyFile, at('secrets', 'vault.key'));
  assert.deepEqual(c.vault.githubRepos, ['someone/atlas-mapper']);
  assert.deepEqual(c.project, {
    name: 'Atlas Mapper',
    description: c.project.description,
    unity: false,
    community: false,
    integration: 'pull-request',
    worldBriefFile: at('pack', 'briefs', 'world-brief.md'),
    orchestratorBriefFile: at('pack', 'briefs', 'orchestrator-brief.md'),
    workerBriefFile: at('pack', 'briefs', 'worker-brief.md'),
  });
  assert.equal(c.providers.ffbox.enabled, false);
  assert.equal(c.max.inbound.enabled, false);
  assert.equal(c.outsideWatch.enabled, false);
  assert.equal(c.voice.enabled, false);
  assert.equal(c.machines.githubFromVault, true);
  assert.equal(c.machines.keepAgentsOnRestart, true);
  assert.deepEqual(c.machines.cleanup, { everyMinutes: 0, softFreeGB: 0, staleOutput: { mode: 'off' } });
  assert.equal(c.hostGuard.pollSeconds, 0);
  assert.equal(c.deviceApproval, 'members');
  // The list's expect matches what it writes, so the updater logs no difference.
  assert.deepEqual(settingsDiff(c, listEntry(opts()).expect), []);
});

test('configFor: a public URL trusts the proxy; a repo off GitHub names no githubRepos; no payer, no unattributed', () => {
  const c = configFor(opts({ publicUrl: 'https://host.tail.ts.net/', repo: 'https://git.example.com/a/b.git', payer: undefined, owner: undefined })) as any;
  checkConfig(c);
  assert.equal(c.trustProxy, true);
  assert.equal(c.publicUrl, 'https://host.tail.ts.net');
  assert.equal(c.vault.githubRepos, undefined);
  assert.equal(c.vault.unattributed, undefined);
  assert.equal(c.ownerName, undefined);
  assert.deepEqual(settingsDiff(c, listEntry(opts({ publicUrl: 'https://host.tail.ts.net' })).expect), []);
});

test('checkConfig: the portal\'s own refusal comes through (a vault key inside the data folder)', () => {
  const c = configFor(opts()) as any;
  c.vault.keyFile = `${c.dataDir}/vault.key`;
  assert.throws(() => checkConfig(c), /must be outside the data folder/);
});

test('githubRepo reads https and ssh URLs', () => {
  assert.equal(githubRepo('https://github.com/bryding/lens-scout.git'), 'bryding/lens-scout');
  assert.equal(githubRepo('git@github.com:bryding/lens-scout.git'), 'bryding/lens-scout');
  assert.equal(githubRepo('https://github.com/bryding/lens-scout'), 'bryding/lens-scout');
  assert.equal(githubRepo('https://gitlab.com/a/b.git'), undefined);
});

test('briefs: three short placeholders that name the project', () => {
  const b = briefs(opts());
  assert.deepEqual(Object.keys(b).sort(), ['orchestrator-brief.md', 'worker-brief.md', 'world-brief.md']);
  for (const t of Object.values(b)) assert.match(t, /Atlas Mapper/);
});

test('startScript: the Lens Scout shape', () => {
  const dir = path.win32.join('F:', 'ffw', 'atlas');
  const s = startScript({ ...opts(), dir, nodeDir: path.win32.join('F:', 'ffw', 'tools', 'node') });
  const lines = s.split('\n');
  assert.equal(lines[0], '#!/bin/bash');
  assert.ok(lines.includes('export PATH="/f/ffw/tools/node:$PATH"'), s);
  assert.ok(
    lines.includes('export FFSB_CONFIG="F:/ffw/atlas/config.json" FFSB_SECRETS_DIR="F:/ffw/atlas/secrets" FFSB_NO_DEELEVATE=1 FF_CLI_SCRUB=off FFSB_TASK_NAME=ffatlas-portal CLAUDE_CONFIG_DIR="F:/ffw/atlas/claude-portal"'),
    s,
  );
  assert.ok(lines.includes('unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN'), s);
  assert.ok(lines.includes('cd "F:/ffw/atlas/app" && exec node server/index.ts >> "F:/ffw/atlas/portal.log" 2>&1'), s);
  assert.equal(msysPath(path.win32.join('C:', 'Program Files', 'nodejs')), '/c/Program Files/nodejs');
});

test('taskScript: the logon task as register-tasks.ps1 registers it', () => {
  const dir = path.win32.join('F:', 'ffw', 'atlas');
  const bash = path.win32.join('C:', 'Program Files', 'Git', 'bin', 'bash.exe');
  const s = taskScript({ ...opts({ project: 'O\'Neil "$x"' }), dir, bash });
  assert.ok(s.includes(`$bash = '${bash}'`), s);
  assert.ok(s.includes(`$dir = '${dir}'`), s);
  assert.ok(s.includes('-RestartCount 999'), s);
  assert.ok(s.includes('-RestartInterval (New-TimeSpan -Minutes 1)'), s);
  assert.ok(s.includes('-MultipleInstances IgnoreNew'), s);
  assert.ok(s.includes('-ExecutionTimeLimit ([TimeSpan]::Zero)'), s);
  assert.ok(s.includes('$user = $env:USERNAME'), s);
  assert.ok(!s.includes('$env:USERDOMAIN'), 'the plain user name, never DOMAIN and user');
  const q = '`"';
  assert.ok(s.includes(`-Execute 'conhost.exe' -Argument "--headless ${q}$bash${q} ${q}${path.win32.join('$dir', 'start-portal.sh')}${q}"`), s);
  assert.ok(s.includes('-LogonType Interactive -RunLevel Limited'), s);
  assert.ok(s.includes('New-ScheduledTaskTrigger -AtLogOn -User $user'), s);
  assert.ok(s.includes("Register-ScheduledTask -TaskName 'ffatlas-portal'"), s);
  assert.ok(s.includes('-Description "O\'Neil `"`$x`" instance atlas on :8893'), 'the project name is escaped in the double-quoted description');
  assert.ok(s.includes('\r\n'), 'CRLF for Windows PowerShell');
});

test('plist: the same environment, kept alive, in Aqua and Background sessions', () => {
  const p = plist({ ...opts({ dir: '/Users/ben/atlas' }), node: '/opt/homebrew/bin/node', home: '/Users/ben' });
  assert.match(p, /<key>Label<\/key><string>com\.ffinstance\.atlas\.portal<\/string>/);
  assert.match(p, /<key>ProgramArguments<\/key><array><string>\/opt\/homebrew\/bin\/node<\/string><string>server\/index\.ts<\/string><\/array>/);
  assert.match(p, /<key>WorkingDirectory<\/key><string>\/Users\/ben\/atlas\/app<\/string>/);
  for (const [k, v] of [
    ['FFSB_CONFIG', '/Users/ben/atlas/config.json'],
    ['FFSB_SECRETS_DIR', '/Users/ben/atlas/secrets'],
    ['FFSB_NO_DEELEVATE', '1'],
    ['FF_CLI_SCRUB', 'off'],
    ['FFSB_TASK_NAME', 'ffatlas-portal'],
    ['CLAUDE_CONFIG_DIR', '/Users/ben/atlas/claude-portal'],
  ])
    assert.ok(p.includes(`<key>${k}</key><string>${v}</string>`), `${k} in\n${p}`);
  assert.match(p, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:/);
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
  assert.match(p, /<key>LimitLoadToSessionType<\/key><array><string>Aqua<\/string><string>Background<\/string><\/array>/);
  assert.match(p, /<key>StandardOutPath<\/key><string>\/Users\/ben\/atlas\/portal\.log<\/string>/);
  assert.equal(launchDomain(501, true), 'gui/501');
  assert.equal(launchDomain(501, false), 'user/501');
});

const empty = { portAnswers: false, listPorts: [] as number[] };

test('refusals: a bad name, a folder in use, a port taken or listed, a listed name', () => {
  assert.deepEqual(refusals(opts(), empty), []);
  assert.match(refusals(opts({ name: 'Atlas_1' }), empty).join(), /--name "Atlas_1"/);
  assert.match(refusals(opts(), { ...empty, dirEntries: ['config.json'] }).join(), /is not empty \(config\.json\)/);
  assert.deepEqual(refusals(opts(), { ...empty, dirEntries: [] }), [], 'an empty folder is fine');
  assert.match(refusals(opts(), { ...empty, portAnswers: true }).join(), /port 8893 answers/);
  assert.match(refusals(opts(), { ...empty, listPorts: [8892, 8893] }).join(), /port 8893 is a listed instance's/);
  const list = { version: 1 as const, leader: { url: 'https://lead.test' }, instances: [{ name: 'atlas', dir: 'x', portalTask: 'ffatlas-portal' }] };
  assert.match(refusals(opts(), { ...empty, list }).join(), /named atlas is in the list already/);
  assert.match(refusals(opts({ port: 80 }), empty).join(), /--port 80/);
  assert.match(refusals(opts({ repo: 'atlas' }), empty).join(), /--repo/);
  assert.match(refusals(opts({ machines: ['M 3'] }), empty).join(), /--machines M 3/);
  assert.match(refusals(opts({ dir: path.join(os.tmpdir(), 'a$b') }), empty).join(), /no quotes/);
});

test('parseOptions: required options, machines lower-cased, --dry-run', () => {
  assert.throws(() => parseOptions(['--name', 'a']), /--project is missing/);
  const o = parseOptions(['--name', 'atlas', '--project', 'Atlas', '--repo', 'https://github.com/a/b.git', '--port', '8893', '--dir', DIR, '--machines', 'Beast, m3', '--dry-run']);
  assert.deepEqual(o.machines, ['beast', 'm3']);
  assert.equal(o.port, 8893);
  assert.equal(o.dryRun, true);
  assert.throws(() => parseOptions(['--nme', 'a']), /Unknown option/);
});

test('the list entry goes into a temp list, checked and written atomically; a second one is refused', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-new-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'instances.json');
  const before = { version: 1, leader: { url: 'https://lead.test', stableMinutes: 5 }, instances: [{ name: 'lens-scout', dir: 'F:/ffw/lens-factory', portalTask: 'fflensscout-portal' }] };
  fs.writeFileSync(file, JSON.stringify(before));
  const entry = listEntry(opts({ dir: path.win32.join('F:', 'ffw', 'atlas'), publicUrl: 'https://h.ts.net' }), 'win32');
  assert.deepEqual(entry, {
    name: 'atlas',
    dir: 'F:/ffw/atlas',
    portalTask: 'ffatlas-portal',
    machines: ['beast', 'm3'],
    daemonInApp: false,
    expect: { deviceApproval: 'members', trustProxy: true, 'machines.keepAgentsOnRestart': true },
  });
  assert.equal(listEntry(opts(), 'darwin').portalTask, 'com.ffinstance.atlas.portal');
  addToList(file, entry, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before, 'a dry run writes nothing');
  addToList(file, entry);
  const l = readList(file);
  assert.equal(listProblem(l), undefined);
  assert.deepEqual(l.instances.map((i) => i.name), ['lens-scout', 'atlas']);
  assert.equal(l.leader.stableMinutes, 5, 'the rest of the list is kept');
  assert.ok(!fs.existsSync(`${file}.tmp`));
  assert.throws(() => addToList(file, entry), /named atlas is in it already/);
});

test("listFromTaskArgs reads the updater task's --list", () => {
  const list = path.win32.join('F:', 'ffw', 'instances', 'instances.json');
  const args = `--headless "${path.win32.join('F:', 'node.exe')}" "${path.win32.join('F:', 'app', 'update-all.ts')}" --list "${list}"`;
  assert.equal(listFromTaskArgs(args), list);
  assert.equal(listFromTaskArgs('x --list /a/instances.json'), '/a/instances.json');
  assert.equal(listFromTaskArgs('x'), undefined);
});

test('nextSteps: the owner\'s login, then per machine its record, credential and install --instance line', () => {
  const o = opts({ dir: path.win32.join('F:', 'ffw', 'atlas'), publicUrl: 'https://beast.tail.ts.net' });
  const s = nextSteps(o, { host: 'beast', win: true, home: path.win32.join('C:', 'Users', 'ben') }).join('\n');
  assert.match(s, /node server\/user\.ts ben --name "Ben" --role owner/);
  assert.match(s, /POST https:\/\/beast\.tail\.ts\.net\/api\/machines\/join \{"id":"m3"\}/);
  // This computer: the credential from vaultCli, the portal over 127.0.0.1, the root in the instance's folder.
  assert.match(s, /node server\/vaultCli\.ts machine-credential issue beast --out "C:\/Users\/ben\/atlas-beast\.credential"/);
  assert.match(s, /install\.ps1\)\)\) -Instance atlas -Root F:\/ffw\/atlas\/worker -PortalUrl http:\/\/127\.0\.0\.1:8893 -RepoUrl https:\/\/github\.com\/someone\/atlas-mapper\.git -ClaudeConfigDir F:\/ffw\/atlas\/worker\/claude -MaxUnity 0 -CredentialFile/);
  // Another machine: redeem the code there, then the installer of its kind.
  assert.match(s, /https:\/\/beast\.tail\.ts\.net\/machine\/join/);
  assert.match(s, /install\.sh\)" -- --instance atlas --root ~\/atlas\/worker --portal-url https:\/\/beast\.tail\.ts\.net --repo-url https:\/\/github\.com\/someone\/atlas-mapper\.git --claude-config-dir ~\/atlas\/worker\/claude --max-unity 0 --credential-file ~\/atlas-m3\.credential/);
});
