import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, checkoutProblem, formatVersions, installedVersions, marketplaceVersions, parseVersions, legacyToolsCheckout, prependPath, publishAgentTools, REPAIR_AFTER, checkoutBackup, checkoutStaging, repairStateFile, readableToolsCheckout, staleAfter, toolsCheckout, type Ran } from './agentTools.ts';
import { toolsResult } from './machineRollout.ts';

/** The agent tools publish on a machine (w1476, server/agentTools.ts; docs/worker-install.md "The agent tools"). */

const SHA = 'a8449abd845705a5e56b8964c912d8f4e6d9a305';
const LATEST = { 'ff-agents': '1.29.20', 'ff-speckit': '1.0.2', 'ff-discord': '1.17.7' };

const installedJson = (v: Record<string, string>) => ({
  version: 2,
  plugins: {
    ...Object.fromEntries(Object.entries(v).map(([p, ver]) => [`${p}@final-factory-agents`, [{ scope: 'user', version: ver, installPath: `/x/${p}/${ver}` }]])),
    'csharp-lsp@claude-plugins-official': [{ scope: 'user', version: '1.0.0' }],
  },
});
const marketplaceJson = (v: Record<string, string>) => ({ name: 'final-factory-agents', plugins: Object.entries(v).map(([name, version]) => ({ name, version, source: `./plugins/${name}` })) });

interface Machine {
  porcelain?: string;
  branch?: string;
  origin?: string;
  fetchCode?: number;
  mergeCode?: number;
  shCode?: number;
  /** registerAgents.sh fails this many runs with shCode, then succeeds (w1895). */
  shFails?: number;
  /** What registerAgents.sh leaves installed. */
  installs?: Record<string, string>;
  /** The checkout exists before the run (else the run clones it). */
  existing?: boolean;
  /** w5597: an old-layout machine: FF Factory's checkout in <root>/tools, which workers write, named by the marker. */
  legacy?: boolean;
  /** The clone of the lasting checkout fails (w5597: a warning, the publish goes on). */
  coCloneCode?: number;
  /** publish-skills' marker before the run (a person's checkout). */
  marker?: string;
  claudeConfigDir?: boolean;
  /** More of the environment `worker.ts tools` runs in. */
  env?: NodeJS.ProcessEnv;
  /** The fresh clone registerAgents.sh runs from fails (w5573). */
  runCloneCode?: number;
  /** w5543: the Medium agents' folder the run also installs into; registerAgents.sh fails there with this code. */
  medium?: boolean;
  mediumShCode?: number;
  /** w5776: the faults above hold only while the checkout carries the planted mark (.git/PLANTED); a clone has none. */
  plantedOnly?: boolean;
}

function machine(o: Machine = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'ffw');
  const claudeDir = o.claudeConfigDir ? path.join(root, 'claude') : path.join(home, '.claude');
  const mediumDir = path.join(root, 'claude-medium');
  fs.mkdirSync(path.join(claudeDir, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify(installedJson({ 'ff-agents': '1.29.19', 'ff-speckit': '1.0.2' })));
  const marker = path.join(home, '.claude', 'final-factory-agents-checkout');
  if (o.marker !== undefined) fs.writeFileSync(marker, o.marker);
  const co = toolsCheckout(root);
  const writeCheckout = (v: Record<string, string>, dir = co) => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify(marketplaceJson(v)));
  };
  if (o.existing) writeCheckout({ 'ff-agents': '1.29.19', 'ff-speckit': '1.0.2', 'ff-discord': '1.17.6' });
  if (o.legacy) {
    writeCheckout({ 'ff-agents': '1.29.19', 'ff-speckit': '1.0.2', 'ff-discord': '1.17.6' }, legacyToolsCheckout(root));
    fs.writeFileSync(marker, `${legacyToolsCheckout(root)}\n`);
  }
  const calls: { cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] = [];
  const lines: string[] = [];
  const ok = (stdout = ''): Ran => ({ code: 0, stdout, stderr: '' });
  const exec = async (cmd: string, args: string[], x: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Ran> => {
    calls.push({ cmd, args, cwd: x.cwd, env: x.env });
    const planted = !o.plantedOnly || fs.existsSync(path.join(x.cwd ?? co, '.git', 'PLANTED'));
    if (cmd === 'git') {
      const a = args.filter((s, i) => !(s === '-c' || args[i - 1] === '-c'));
      if (a[0] === 'clone') {
        if (o.runCloneCode && a.includes('--depth')) return { code: o.runCloneCode, stdout: '', stderr: 'fatal: unable to access' };
        if (o.coCloneCode && !a.includes('--depth')) return { code: o.coCloneCode, stdout: '', stderr: 'fatal: unable to access' };
        writeCheckout(LATEST, a.at(-1));
        return ok();
      }
      if (a[0] === '-C' && a.slice(2).join(' ') === 'rev-parse HEAD') return ok(`${SHA}\n`);
      if (a[0] === 'status') return ok((planted && o.porcelain) || '');
      if (a.join(' ') === 'rev-parse --abbrev-ref HEAD') return ok(`${(planted && o.branch) || 'master'}\n`);
      if (a[0] === 'config') return ok(`${(planted && o.origin) || 'https://github.com/Final-Factory/final-factory-agents.git'}\n`);
      if (a[0] === 'fetch') return { code: (planted && o.fetchCode) || 0, stdout: '', stderr: planted && o.fetchCode ? 'fatal: unable to access' : '' };
      if (a[0] === 'merge') {
        if (planted && o.mergeCode) return { code: o.mergeCode, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' };
        writeCheckout(LATEST);
        return ok();
      }
      if (a.join(' ') === 'rev-parse HEAD') return ok(`${SHA}\n`);
      return { code: 1, stdout: '', stderr: `unexpected git ${a.join(' ')}` };
    }
    if (cmd === 'sh') {
      // registerAgents.sh: records the checkout it ran from, refreshes the marketplace, updates every remembered plugin.
      fs.writeFileSync(marker, `${x.cwd}\n`);
      const into = x.env?.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
      const mediumRun = into === mediumDir;
      const fails = mediumRun ? o.mediumShCode !== undefined : o.shCode !== undefined && (o.shFails === undefined || calls.filter((c) => c.cmd === 'sh').length <= o.shFails);
      if (!fails) {
        fs.mkdirSync(path.join(into, 'plugins'), { recursive: true });
        fs.writeFileSync(path.join(into, 'plugins', 'installed_plugins.json'), JSON.stringify(installedJson(o.installs ?? { 'ff-agents': '1.29.20', 'ff-speckit': '1.0.2' })));
      }
      const code = fails ? (mediumRun ? o.mediumShCode! : o.shCode!) : 0;
      return { code, stdout: "== Claude Code ==\nmarketplace 'final-factory-agents' already registered — refreshing from GitHub\nchecking 'ff-agents@final-factory-agents' for updates\n", stderr: code ? 'claude CLI not on PATH — skipping Claude Code' : '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${cmd}` };
  };
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: home, ...(o.claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeDir } : {}), ...o.env };
  const tmpdir = path.join(base, 'tmp');
  fs.mkdirSync(tmpdir);
  const run = (claude?: string) => publishAgentTools(root, { exec, say: (l) => lines.push(l), env, home, platform: 'linux', tmpdir }, { claude, ...(o.medium ? { medium: mediumDir } : {}) });
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined);
  return { root, co, tmpdir, calls, lines, run, mediumDir, marker: () => read(marker), installed: () => installedVersions(JSON.parse(read(path.join(claudeDir, 'plugins', 'installed_plugins.json'))!)) };
}

const ran = (m: ReturnType<typeof machine>, what: string) => m.calls.filter((c) => [c.cmd, ...c.args].join(' ').includes(what));

/** A person's own final-factory-agents checkout (BEAST's ~/final-factory-agents), which the marker may name. */
function personCheckout(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'person-')), 'final-factory-agents');
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify(marketplaceJson(LATEST)));
  return dir;
}

test('w5784: a marker naming no checkout (a removed ff-agents-run-* folder, or empty) is not put back: it names the lasting checkout', async () => {
  for (const before of ['F:/ffw/tools/ff-agents-run-jadTAl/final-factory-agents\n', '\n']) {
    const m = machine({ marker: before, medium: true });
    assert.equal(await m.run(), EXIT.ok);
    assert.equal(m.marker(), `${m.co}\n`, 'the marker names a checkout that exists');
    assert.ok(m.lines.includes(`publish-skills' checkout marker now names ${m.co} (it named ${before.trim() || 'nothing'}, which is not a checkout).`));
    assert.equal(m.lines.filter((l) => l.includes('checkout marker')).at(-1), `publish-skills' checkout marker kept on ${m.co}.`, 'the Medium pass finds it healed and keeps it');
  }
  // With no lasting checkout this run there is nothing better to name: it stays as it was.
  const m = machine({ marker: 'F:/gone\n', coCloneCode: 128 });
  assert.equal(await m.run(), EXIT.ok);
  assert.equal(m.marker(), 'F:/gone\n');
});

test("a first run clones FF Factory's own checkout in the root, runs registerAgents.sh from it, and verifies every plugin is on master", async () => {
  const person = personCheckout();
  const m = machine({ marker: `${person}\n` });
  assert.equal(await m.run('/home/x/.local/bin/claude'), EXIT.ok);
  assert.equal(m.co, path.join(m.root, 'tools-medium', 'final-factory-agents'), 'w5597: inside the worker root, in the child only Medium writes');
  const clone = ran(m, 'clone')[0];
  assert.ok(clone.args.includes('https://github.com/Final-Factory/final-factory-agents.git') && clone.args.includes(m.co));
  assert.deepEqual(clone.args.slice(0, 4), ['-c', 'credential.helper=', '-c', 'credential.interactive=never'], 'anonymous: an ssh session reaches no keychain');
  assert.equal(clone.env?.GIT_TERMINAL_PROMPT, '0');
  const sh = m.calls.find((c) => c.cmd === 'sh')!;
  assert.deepEqual(sh.args, ['registerAgents.sh', '--claude']);
  assert.notEqual(sh.cwd, m.co, 'w5573: not from the checkout a worker can write');
  assert.equal(path.dirname(path.dirname(sh.cwd!)), m.tmpdir);
  assert.equal(fs.existsSync(sh.cwd!), false, 'the fresh clone is removed after the run');
  assert.match(sh.env?.PATH ?? '', /^\/home\/x\/\.local\/bin:/, "the daemon's Claude Code comes first on PATH");
  assert.equal(m.marker(), `${person}\n`, "publish-skills' marker still names the person's checkout");
  assert.deepEqual(m.lines.filter((l) => l.startsWith('Agent tools')), [
    'Agent tools before: ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord not installed',
    'Agent tools latest: final-factory-agents a8449abd8457: ff-agents 1.29.20, ff-speckit 1.0.2, ff-discord 1.17.7',
    `Agent tools checkout: ${m.co} at a8449abd8457`,
    'Agent tools after: ff-agents 1.29.20, ff-speckit 1.0.2, ff-discord not installed',
    'Agent tools published: every installed plugin is on master. Running agents keep the version they started with; new sessions load these.',
  ]);
  assert.ok(m.lines.includes('  == Claude Code =='), "registerAgents.sh's own output is passed on");
});

test('a later run fast-forwards its checkout and touches nothing else; with no marker before, the new one is reported', async () => {
  const m = machine({ existing: true });
  assert.equal(await m.run(), EXIT.ok);
  assert.equal(ran(m, 'clone').filter((c) => c.args.includes(m.co)).length, 0);
  assert.deepEqual(ran(m, 'fetch')[0].args.slice(-3), ['--quiet', 'origin', 'master']);
  assert.deepEqual(ran(m, 'merge')[0].args.slice(-3), ['--ff-only', '--quiet', 'origin/master'], 'a fast-forward only, never a reset');
  assert.ok(m.lines.some((l) => l.includes(`checkout marker now names ${m.co} (there was none)`)));
});

test('w5597: its checkout dirty, on another branch, from another repo or diverged: nothing overwritten, a WARNING, and the publish goes on from the fresh clone', async () => {
  for (const [o, why] of [
    [{ porcelain: ' M plugins/ff-agents/skills/x/SKILL.md\n?? notes.txt\n' }, /has uncommitted changes \(2 paths\)/],
    [{ branch: 'w1258-ab-leg' }, /is on w1258-ab-leg, not master/],
    [{ origin: 'https://github.com/someone/fork.git' }, /has origin https:\/\/github\.com\/someone\/fork\.git, not/],
    [{ mergeCode: 128 }, /has commits origin\/master does not \(it cannot fast-forward\)/],
  ] as [Machine, RegExp][]) {
    const m = machine({ existing: true, ...o });
    assert.equal(await m.run(), EXIT.ok);
    assert.match(m.lines.find((l) => l.startsWith('WARNING:'))!, why);
    assert.match(m.lines.find((l) => l.startsWith('WARNING:'))!, /nothing in it was overwritten; this run publishes from a fresh clone/);
    assert.ok(m.lines.includes('Agent tools after: ff-agents 1.29.20, ff-speckit 1.0.2, ff-discord not installed'));
    assert.equal(m.calls.filter((c) => c.cmd === 'sh').length, 1);
    assert.equal(toolsResult(0, m.lines.join('\n')).warnings?.length, 1, 'the rollout report carries the warning');
    assert.equal(ran(m, 'reset').length + ran(m, 'stash').length + ran(m, 'checkout').length + ran(m, 'clean').length, 0);
  }
});

test('w5776: a folder in the way that is not a checkout is moved aside at once, kept, and the checkout cloned again', async () => {
  const m = machine();
  fs.mkdirSync(m.co, { recursive: true });
  fs.writeFileSync(path.join(m.co, 'keep.txt'), 'x');
  assert.equal(await m.run(), EXIT.ok);
  assert.equal(fs.readFileSync(path.join(checkoutBackup(m.root), 'keep.txt'), 'utf8'), 'x', 'the one backup keeps what was there');
  assert.equal(ran(m, 'clone').filter((c) => c.args.includes(checkoutStaging(m.root))).length, 1);
  assert.ok(m.lines.includes(`WARNING: ${m.co} holds files but no git checkout; it was moved to ${checkoutBackup(m.root)} (the one backup kept) and replaced by a new clone.`));
  assert.ok(m.lines.includes(`Agent tools checkout: ${m.co} at a8449abd8457`));
  assert.equal(m.marker(), `${m.co}\n`);
});

test('w5776: each broken state is repaired after the same WARNING on REPAIR_AFTER publishes in a row, and the next publish finds a clean checkout', async () => {
  for (const [o, why] of [
    [{ porcelain: ' M plugins/ff-agents/skills/x/SKILL.md\n' }, /has uncommitted changes \(1 path\)/],
    [{ branch: 'w1258-ab-leg' }, /is on w1258-ab-leg, not master/],
    [{ origin: 'https://github.com/someone/fork.git' }, /has origin https:\/\/github\.com\/someone\/fork\.git, not/],
    [{ mergeCode: 128 }, /has commits origin\/master does not \(it cannot fast-forward\)/],
    [{ fetchCode: 128 }, /could not be fetched from final-factory-agents \(fatal: unable to access\)/],
  ] as [Machine, RegExp][]) {
    const m = machine({ existing: true, plantedOnly: true, ...o });
    fs.writeFileSync(path.join(m.co, '.git', 'PLANTED'), '');
    for (let i = 1; i < REPAIR_AFTER; i++) {
      m.lines.length = 0;
      assert.equal(await m.run(), EXIT.ok);
      const w = m.lines.filter((l) => l.startsWith('WARNING:'));
      assert.equal(w.length, 1);
      assert.match(w[0], why);
      assert.ok(w[0].endsWith(`(${i} of ${REPAIR_AFTER} publishes in a row before it is moved aside and cloned again).`), w[0]);
      assert.ok(fs.existsSync(path.join(m.co, '.git', 'PLANTED')), 'nothing is moved before the last');
    }
    m.lines.length = 0;
    assert.equal(await m.run(), EXIT.ok);
    const w = m.lines.filter((l) => l.startsWith('WARNING:'));
    assert.equal(w.length, 1, w.join(' / '));
    assert.match(w[0], why);
    assert.ok(w[0].endsWith(` for ${REPAIR_AFTER} publishes in a row; it was moved to ${checkoutBackup(m.root)} (the one backup kept) and replaced by a new clone.`), w[0]);
    assert.ok(fs.existsSync(path.join(checkoutBackup(m.root), '.git', 'PLANTED')), 'the broken one is the backup');
    assert.ok(m.lines.includes(`Repaired FF Factory's checkout: cloned final-factory-agents into ${m.co} again.`));
    assert.ok(m.lines.includes(`Agent tools checkout: ${m.co} at a8449abd8457`));
    assert.equal(fs.existsSync(repairStateFile(m.root)), false);
    // The next publish: a clean checkout, taken forward, no WARNING.
    m.lines.length = 0;
    assert.equal(await m.run(), EXIT.ok);
    assert.deepEqual(m.lines.filter((l) => l.startsWith('WARNING:')), []);
    assert.ok(m.lines.includes(`Agent tools checkout: ${m.co} at a8449abd8457`));
    assert.equal(ran(m, 'reset').length + ran(m, 'stash').length + ran(m, 'checkout').length + ran(m, 'clean').length, 0, 'never a reset over what is there');
  }
});

test('w5776: a different fault, or a clean run, starts the count again', async () => {
  const m = machine({ existing: true, plantedOnly: true, branch: 'leg' });
  fs.writeFileSync(path.join(m.co, '.git', 'PLANTED'), '');
  for (let i = 1; i < REPAIR_AFTER; i++) await m.run();
  assert.deepEqual(JSON.parse(fs.readFileSync(repairStateFile(m.root), 'utf8')), { kind: 'is on leg, not master', count: REPAIR_AFTER - 1 });
  fs.rmSync(path.join(m.co, '.git', 'PLANTED'));
  m.lines.length = 0;
  await m.run();
  assert.deepEqual(m.lines.filter((l) => l.startsWith('WARNING:')), []);
  assert.equal(fs.existsSync(repairStateFile(m.root)), false, 'a clean run clears the count');
  fs.writeFileSync(path.join(m.co, '.git', 'PLANTED'), '');
  m.lines.length = 0;
  await m.run();
  assert.ok(m.lines.some((l) => l.endsWith(`(1 of ${REPAIR_AFTER} publishes in a row before it is moved aside and cloned again).`)));
});

test('w5776: on the real file system (NTFS on Windows) a real git checkout is moved aside, and an older backup with read-only git objects is removed', async () => {
  const m = machine({ plantedOnly: true, porcelain: '?? x\n' });
  const real = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const g = (...a: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=', '-C', dir, ...a], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    g('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    g('add', 'a.txt');
    g('commit', '-q', '-m', 'a');
    fs.writeFileSync(path.join(dir, '.git', 'PLANTED'), '');
  };
  real(m.co);
  real(checkoutBackup(m.root));
  fs.writeFileSync(path.join(checkoutBackup(m.root), 'older.txt'), 'x');
  const objects = (dir: string) => fs.readdirSync(path.join(dir, '.git', 'objects'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
  assert.ok(objects(checkoutBackup(m.root)) >= 3);
  for (let i = 0; i < REPAIR_AFTER; i++) assert.equal(await m.run(), EXIT.ok);
  assert.equal(fs.existsSync(path.join(checkoutBackup(m.root), 'older.txt')), false, 'the older backup is gone');
  assert.ok(fs.existsSync(path.join(checkoutBackup(m.root), '.git', 'PLANTED')), 'the newer broken checkout is the backup');
  assert.equal(fs.existsSync(path.join(m.co, '.git', 'PLANTED')), false, 'cloned again');
  assert.ok(m.lines.includes(`Agent tools checkout: ${m.co} at a8449abd8457`));
});

test('w5776 follow-up: a repair whose new clone fails (the network) leaves the old checkout where it is and keeps the count', async () => {
  // w5787's review: three failed fetches most likely mean no network; moving the checkout first left readers nothing.
  const m = machine({ existing: true, plantedOnly: true, fetchCode: 128, coCloneCode: 128 });
  fs.writeFileSync(path.join(m.co, '.git', 'PLANTED'), '');
  for (let i = 0; i < REPAIR_AFTER; i++) assert.equal(await m.run(), EXIT.ok);
  assert.ok(m.lines.some((l) => l.startsWith(`WARNING: ${m.co} could not be fetched`) && l.includes(`for ${REPAIR_AFTER} publishes in a row, and a new clone to replace it failed (fatal: unable to access); it is left as it is`)), m.lines.join('\n'));
  assert.ok(fs.existsSync(path.join(m.co, '.git', 'PLANTED')), 'the old checkout stays');
  assert.equal(fs.existsSync(checkoutBackup(m.root)), false, 'nothing was moved aside');
  assert.equal(fs.existsSync(checkoutStaging(m.root)), false, 'no half clone is left');
  assert.equal(JSON.parse(fs.readFileSync(repairStateFile(m.root), 'utf8')).count, REPAIR_AFTER, 'the count is kept, so the next publish tries again');
  assert.ok(m.lines.some((l) => l.startsWith(`Agent tools checkout: ${m.co} at `)), 'readers keep a checkout');
});

test('w5776 follow-up: a backup that is a link (a junction on Windows) is removed, never what it points to', async () => {
  // w5787's review measured this on beast; the test holds the line on NTFS, APFS and ext4 (Node's rmSync went native in 23).
  const m = machine({ existing: true, plantedOnly: true, branch: 'leg' });
  fs.writeFileSync(path.join(m.co, '.git', 'PLANTED'), '');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-target-'));
  fs.writeFileSync(path.join(target, 'precious.txt'), 'x');
  fs.symlinkSync(target, checkoutBackup(m.root), process.platform === 'win32' ? 'junction' : 'dir');
  for (let i = 0; i < REPAIR_AFTER; i++) assert.equal(await m.run(), EXIT.ok);
  assert.equal(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8'), 'x', 'the link target is untouched');
  assert.ok(fs.lstatSync(checkoutBackup(m.root)).isDirectory() && !fs.lstatSync(checkoutBackup(m.root)).isSymbolicLink(), 'the backup is now the broken checkout itself');
  assert.ok(fs.existsSync(path.join(checkoutBackup(m.root), '.git', 'PLANTED')));
  assert.equal(fs.existsSync(path.join(m.co, '.git', 'PLANTED')), false, 'cloned again');
  fs.rmSync(target, { recursive: true, force: true });
});

test('a fetch or registerAgents.sh failure, or a plugin left behind master, fails and says which', async () => {
  // w5597: the lasting checkout's fetch is a warning; the fresh clone the plugins come from decides.
  const f = machine({ existing: true, fetchCode: 128 });
  assert.equal(await f.run(), EXIT.ok);
  assert.ok(f.lines.some((l) => /^WARNING: .* could not be fetched from final-factory-agents \(fatal: unable to access\); this run publishes from a fresh clone \(1 of 3 /.test(l)));
  const s = machine({ shCode: 1, installs: { 'ff-agents': '1.29.19', 'ff-speckit': '1.0.2' } });
  assert.equal(await s.run(), EXIT.failed);
  assert.match(s.lines.at(-1)!, /^FAILED: registerAgents\.sh exited 1: claude CLI not on PATH/);
  assert.ok(s.lines.includes('Agent tools after: ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord not installed'), 'the versions after are still read');
  const st = machine({ installs: { 'ff-agents': '1.29.20', 'ff-discord': '1.17.6' } });
  assert.equal(await st.run(), EXIT.failed);
  assert.match(st.lines.at(-1)!, /^FAILED: not on master's version after registerAgents\.sh: ff-speckit not installed \(master: 1\.0\.2\), ff-discord 1\.17\.6 \(master: 1\.17\.7\)\./);
});

test('w1895: registerAgents.sh fetches the marketplace over HTTPS only, and a failed run is run once more', async () => {
  // m5, 2026-10-23: its HTTPS fetch failed, Claude Code fell back to SSH with a key no GitHub account holds, and the step
  // reported only "Please make sure you have the correct access rights"; the next rollout's run passed.
  const m = machine({ shCode: 1, shFails: 1 });
  assert.equal(await m.run(), EXIT.ok);
  const runs = ran(m, 'registerAgents.sh');
  assert.equal(runs.length, 2);
  for (const r of runs) {
    assert.equal(r.env?.CLAUDE_CODE_PLUGIN_PREFER_HTTPS, '1', 'no SSH attempt, so no SSH fallback error');
    assert.equal(r.env?.CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS, '300000');
    assert.equal(r.env?.PATH, '/usr/bin', 'the rest of the environment is kept');
    assert.equal(r.env?.GIT_TERMINAL_PROMPT, '0');
  }
  assert.ok(m.lines.includes('registerAgents.sh exited 1 (claude CLI not on PATH — skipping Claude Code); running it once more.'));
  assert.equal(m.installed()['ff-agents'], '1.29.20');
  assert.equal(m.lines.at(-1), 'Agent tools published: every installed plugin is on master. Running agents keep the version they started with; new sessions load these.');

  const twice = machine({ shCode: 1 });
  assert.equal(await twice.run(), EXIT.failed);
  assert.equal(ran(twice, 'registerAgents.sh').length, 2, 'once more, not again and again');

  const timedOut = machine({ shCode: -1 });
  assert.equal(await timedOut.run(), EXIT.failed);
  assert.equal(ran(timedOut, 'registerAgents.sh').length, 1, 'a run that used its whole timeout is not run again');
  assert.match(timedOut.lines.at(-1)!, /^FAILED: registerAgents\.sh exited -1 \(timed out or could not start\)/);

  const own = machine({ env: { CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS: '900000' } });
  assert.equal(await own.run(), EXIT.ok);
  assert.equal(ran(own, 'registerAgents.sh')[0].env?.CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS, '900000', "a machine's own value is kept");
});

test("CLAUDE_CONFIG_DIR is where Claude Code's plugins are read, as the workers' Claude Code reads them", async () => {
  const m = machine({ claudeConfigDir: true });
  assert.equal(await m.run(), EXIT.ok);
  assert.equal(m.installed()['ff-agents'], '1.29.20');
  assert.ok(m.lines.includes('Agent tools before: ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord not installed'));
});

test("daemon.json's claude goes first on the search path the environment already has (Windows: Path, one key)", () => {
  // w1476: beast's first rollout set PATH beside a copied Path, and git was not found ("spawn git ENOENT").
  const win: NodeJS.ProcessEnv = { Path: 'C:\\Program Files\\Git\\cmd;C:\\Windows', HOME: 'C:\\Users\\x' };
  prependPath(win, 'C:\\Users\\x\\.local\\bin', 'win32');
  assert.deepEqual(Object.keys(win).filter((k) => k.toUpperCase() === 'PATH'), ['Path']);
  assert.equal(win.Path, 'C:\\Users\\x\\.local\\bin;C:\\Program Files\\Git\\cmd;C:\\Windows');
  const unix: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
  prependPath(unix, '/home/x/.local/bin', 'linux');
  assert.equal(unix.PATH, '/home/x/.local/bin:/usr/bin');
});

test('the version helpers', () => {
  assert.deepEqual(installedVersions(undefined), { 'ff-agents': undefined, 'ff-speckit': undefined, 'ff-discord': undefined });
  assert.deepEqual(installedVersions({ plugins: { 'ff-agents@final-factory-agents': [{ scope: 'project', version: '1.0.0' }, { scope: 'user', version: '1.29.20' }] } })['ff-agents'], '1.29.20', 'the user-scope install');
  assert.deepEqual(marketplaceVersions(marketplaceJson(LATEST)), LATEST);
  const v = { 'ff-agents': '1.29.20', 'ff-speckit': '1.0.2', 'ff-discord': undefined };
  assert.equal(formatVersions(v), 'ff-agents 1.29.20, ff-speckit 1.0.2, ff-discord not installed');
  assert.deepEqual(parseVersions(formatVersions(v)), v);
  assert.deepEqual(parseVersions(' ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord 1.17.7 (unchanged)'), { 'ff-agents': '1.29.19', 'ff-speckit': '1.0.2', 'ff-discord': '1.17.7' });
  assert.deepEqual(staleAfter(v, LATEST), [], 'ff-discord only where a person asked for it: not installed is fine');
  assert.deepEqual(staleAfter({ 'ff-speckit': '1.0.2' }, LATEST), ['ff-agents not installed (master: 1.29.20)']);
  assert.equal(checkoutProblem({ porcelain: '', branch: 'master', origin: 'git@github.com:Final-Factory/final-factory-agents.git' }), undefined);
  assert.equal(checkoutProblem({ porcelain: '', branch: '', origin: 'https://github.com/Final-Factory/final-factory-agents' }), 'is on a detached HEAD, not master');
});

test('w5573: registerAgents.sh runs from a fresh clone made with no global or system config, never from the root checkout', async () => {
  const m = machine({ existing: true });
  // A worker planted a script in the root's checkout: it is never run.
  fs.writeFileSync(path.join(m.co, 'registerAgents.sh'), 'touch planted\n');
  assert.equal(await m.run(), EXIT.ok);
  const fresh = ran(m, '--depth')[0];
  assert.ok(fresh.args.join(' ').includes('clone --quiet --depth 1 --single-branch --branch master'));
  assert.ok(fresh.args.includes('https://github.com/Final-Factory/final-factory-agents.git'));
  assert.equal(fresh.env?.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(fs.existsSync(fresh.env!.GIT_CONFIG_GLOBAL!), false, 'an empty global config in the run folder, removed with it');
  assert.equal(fresh.env?.GIT_NO_REPLACE_OBJECTS, '1');
  for (const sh of ran(m, 'registerAgents.sh')) assert.equal(sh.cwd, fresh.args.at(-1));
  assert.equal(fs.readdirSync(m.tmpdir).length, 0);

  const f = machine({ existing: true, runCloneCode: 128 });
  assert.equal(await f.run(), EXIT.failed);
  assert.match(f.lines.at(-1)!, /^FAILED: could not make a fresh clone of .* to run registerAgents\.sh from/);
  assert.equal(f.calls.filter((c) => c.cmd === 'sh').length, 0);
  assert.equal(fs.readdirSync(f.tmpdir).length, 0);
});

test("w5543: one run installs the plugins into the workers' folder and the Medium agents' one, and fails when either is behind", async () => {
  const m = machine({ claudeConfigDir: true, medium: true });
  assert.equal(await m.run(), EXIT.ok);
  const sh = m.calls.filter((c) => c.cmd === 'sh');
  assert.deepEqual(sh.map((c) => c.env?.CLAUDE_CONFIG_DIR), [path.join(m.root, 'claude'), m.mediumDir], 'both folders, from the one checkout');
  // w5573: both from the one fresh clone, not the root's checkout.
  assert.equal(new Set(sh.map((c) => c.cwd)).size, 1);
  assert.notEqual(sh[0].cwd, m.co);
  assert.equal(ran(m, '--depth').length, 1, 'one fresh clone for both folders');
  assert.deepEqual(installedVersions(JSON.parse(fs.readFileSync(path.join(m.mediumDir, 'plugins', 'installed_plugins.json'), 'utf8'))), { 'ff-agents': '1.29.20', 'ff-speckit': '1.0.2', 'ff-discord': undefined });
  assert.ok(m.lines.includes(`Agent tools before (Medium agents, ${m.mediumDir}): ff-agents not installed, ff-speckit not installed, ff-discord not installed`));
  assert.equal(m.lines.filter((l) => l.startsWith('Agent tools after:')).length, 1, "the rollout reads the workers' folder's line");
  const bad = machine({ claudeConfigDir: true, medium: true, mediumShCode: 1 });
  assert.equal(await bad.run(), EXIT.failed);
  assert.ok(bad.lines.some((l) => l.startsWith(`FAILED (Medium agents, ${bad.mediumDir}): registerAgents.sh exited 1`)));
  // w5946 F6: a workers' folder that fails (a worker can break its own) still lets the Medium agents' one refresh.
  const workers = machine({ claudeConfigDir: true, medium: true, shCode: 1 });
  assert.equal(await workers.run(), EXIT.failed);
  assert.ok(workers.calls.some((c) => c.cmd === 'sh' && c.env?.CLAUDE_CONFIG_DIR === workers.mediumDir), 'the Medium refresh ran');
  assert.deepEqual(installedVersions(JSON.parse(fs.readFileSync(path.join(workers.mediumDir, 'plugins', 'installed_plugins.json'), 'utf8')))['ff-agents'], '1.29.20');
});

test('w5597: an old-layout machine migrates: the new checkout is cloned, the old one is never run, fetched or written, and the marker moves', async () => {
  const m = machine({ legacy: true });
  const old = legacyToolsCheckout(m.root);
  // What a fenced worker could plant in the old checkout: a script and a hook.
  fs.writeFileSync(path.join(old, 'registerAgents.sh'), 'touch planted\n');
  fs.mkdirSync(path.join(old, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(old, '.git', 'hooks', 'post-merge'), '#!/bin/sh\ntouch planted\n');
  assert.equal(await m.run(), EXIT.ok);
  for (const c of m.calls) {
    assert.ok(!(c.cwd ?? '').startsWith(old), `nothing runs in the old checkout: ${c.cmd} ${c.args.join(' ')} in ${c.cwd}`);
    assert.ok(!c.args.some((a) => a.startsWith(old)), `no git names the old checkout: ${c.args.join(' ')}`);
  }
  assert.ok(ran(m, 'clone').some((c) => c.args.at(-1) === m.co), 'the new checkout is cloned');
  assert.equal(fs.readFileSync(path.join(old, 'registerAgents.sh'), 'utf8'), 'touch planted\n', 'the old checkout is left as it is');
  assert.ok(m.lines.some((l) => l.startsWith(`Cloned final-factory-agents into ${m.co} (FF Factory's own checkout, which no worker can write; the old ${old} is no longer used`)));
  assert.equal(m.marker(), `${m.co}\n`, "publish-skills' marker moves with the checkout");
  assert.ok(m.lines.includes(`publish-skills' checkout marker now names ${m.co} (it named the old ${old}).`));
  // The rollout still reads the run.
  const t = toolsResult(0, m.lines.join('\n'));
  assert.equal(t.status, 'ok');
  assert.equal(t.latestSha, SHA.slice(0, 12));
  assert.equal(t.checkout, `${m.co} at a8449abd8457`);
});

test('w5597: every git the publish runs reads hooks from an empty folder of its own; the lasting clone failing is a warning, not a failed publish', async () => {
  const m = machine({ existing: true });
  assert.equal(await m.run(), EXIT.ok);
  const gits = m.calls.filter((c) => c.cmd === 'git');
  assert.ok(gits.length >= 6);
  const hooks = new Set<string>();
  for (const c of gits) {
    const i = c.args.findIndex((a) => a.startsWith('core.hooksPath='));
    assert.ok(i > 0 && c.args[i - 1] === '-c', `hooksPath on: ${c.args.join(' ')}`);
    hooks.add(c.args[i].slice('core.hooksPath='.length));
    assert.ok(c.env?.GIT_CONFIG_GLOBAL, 'an empty global config of its own');
  }
  assert.equal(hooks.size, 1);
  const h = [...hooks][0];
  assert.equal(path.dirname(path.dirname(h)), m.tmpdir, "the run's own folder");
  assert.equal(fs.existsSync(h), false, 'removed with the run');

  const f = machine({ coCloneCode: 128 });
  assert.equal(await f.run(), EXIT.ok);
  assert.ok(f.lines.some((l) => l.startsWith(`WARNING: could not clone https://github.com/Final-Factory/final-factory-agents.git into ${f.co}`)));
  assert.equal(f.calls.filter((c) => c.cmd === 'sh').length, 1);
});

test('w5597: readers take the new checkout, else the old one until it moves', () => {
  const root = path.join(os.tmpdir(), 'r');
  const rel = path.join('plugins', 'ff-agents', 'skills');
  const has = (...dirs: string[]) => (p: string) => dirs.some((d) => p === path.join(d, rel));
  assert.equal(readableToolsCheckout(root, rel, has(toolsCheckout(root), legacyToolsCheckout(root))), toolsCheckout(root));
  assert.equal(readableToolsCheckout(root, rel, has(legacyToolsCheckout(root))), legacyToolsCheckout(root));
  assert.equal(readableToolsCheckout(root, rel, has()), undefined);
});
