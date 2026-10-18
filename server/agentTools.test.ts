import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, checkoutProblem, formatVersions, installedVersions, marketplaceVersions, parseVersions, prependPath, publishAgentTools, staleAfter, toolsCheckout, type Ran } from './agentTools.ts';

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
  /** What registerAgents.sh leaves installed. */
  installs?: Record<string, string>;
  /** The checkout exists before the run (else the run clones it). */
  existing?: boolean;
  /** publish-skills' marker before the run (a person's checkout). */
  marker?: string;
  claudeConfigDir?: boolean;
}

function machine(o: Machine = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'ffw');
  const claudeDir = o.claudeConfigDir ? path.join(root, 'claude') : path.join(home, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify(installedJson({ 'ff-agents': '1.29.19', 'ff-speckit': '1.0.2' })));
  const marker = path.join(home, '.claude', 'final-factory-agents-checkout');
  if (o.marker !== undefined) fs.writeFileSync(marker, o.marker);
  const co = toolsCheckout(root);
  const writeCheckout = (v: Record<string, string>) => {
    fs.mkdirSync(path.join(co, '.git'), { recursive: true });
    fs.mkdirSync(path.join(co, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(co, '.claude-plugin', 'marketplace.json'), JSON.stringify(marketplaceJson(v)));
  };
  if (o.existing) writeCheckout({ 'ff-agents': '1.29.19', 'ff-speckit': '1.0.2', 'ff-discord': '1.17.6' });
  const calls: { cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] = [];
  const lines: string[] = [];
  const ok = (stdout = ''): Ran => ({ code: 0, stdout, stderr: '' });
  const exec = async (cmd: string, args: string[], x: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Ran> => {
    calls.push({ cmd, args, cwd: x.cwd, env: x.env });
    if (cmd === 'git') {
      const a = args.filter((s, i) => !(s === '-c' || args[i - 1] === '-c'));
      if (a[0] === 'clone') {
        writeCheckout(LATEST);
        return ok();
      }
      if (a[0] === 'status') return ok(o.porcelain ?? '');
      if (a.join(' ') === 'rev-parse --abbrev-ref HEAD') return ok(`${o.branch ?? 'master'}\n`);
      if (a[0] === 'config') return ok(`${o.origin ?? 'https://github.com/Final-Factory/final-factory-agents.git'}\n`);
      if (a[0] === 'fetch') return { code: o.fetchCode ?? 0, stdout: '', stderr: o.fetchCode ? 'fatal: unable to access' : '' };
      if (a[0] === 'merge') {
        if (o.mergeCode) return { code: o.mergeCode, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' };
        writeCheckout(LATEST);
        return ok();
      }
      if (a.join(' ') === 'rev-parse HEAD') return ok(`${SHA}\n`);
      return { code: 1, stdout: '', stderr: `unexpected git ${a.join(' ')}` };
    }
    if (cmd === 'sh') {
      // registerAgents.sh: records the checkout it ran from, refreshes the marketplace, updates every remembered plugin.
      fs.writeFileSync(marker, `${co}\n`);
      fs.writeFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify(installedJson(o.installs ?? { 'ff-agents': '1.29.20', 'ff-speckit': '1.0.2' })));
      return { code: o.shCode ?? 0, stdout: "== Claude Code ==\nmarketplace 'final-factory-agents' already registered — refreshing from GitHub\nchecking 'ff-agents@final-factory-agents' for updates\n", stderr: o.shCode ? 'claude CLI not on PATH — skipping Claude Code' : '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${cmd}` };
  };
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: home, ...(o.claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeDir } : {}) };
  const run = (claude?: string) => publishAgentTools(root, { exec, say: (l) => lines.push(l), env, home, platform: 'linux' }, { claude });
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined);
  return { root, co, calls, lines, run, marker: () => read(marker), installed: () => installedVersions(JSON.parse(read(path.join(claudeDir, 'plugins', 'installed_plugins.json'))!)) };
}

const ran = (m: ReturnType<typeof machine>, what: string) => m.calls.filter((c) => [c.cmd, ...c.args].join(' ').includes(what));

test("a first run clones FF Factory's own checkout in the root, runs registerAgents.sh from it, and verifies every plugin is on master", async () => {
  const m = machine({ marker: 'C:/Users/rydin/final-factory-agents\n' });
  assert.equal(await m.run('/home/x/.local/bin/claude'), EXIT.ok);
  assert.equal(m.co, path.join(m.root, 'tools', 'final-factory-agents'), 'inside the worker root');
  const clone = ran(m, 'clone')[0];
  assert.ok(clone.args.includes('https://github.com/Final-Factory/final-factory-agents.git') && clone.args.includes(m.co));
  assert.deepEqual(clone.args.slice(0, 4), ['-c', 'credential.helper=', '-c', 'credential.interactive=never'], 'anonymous: an ssh session reaches no keychain');
  assert.equal(clone.env?.GIT_TERMINAL_PROMPT, '0');
  const sh = m.calls.find((c) => c.cmd === 'sh')!;
  assert.deepEqual(sh.args, ['registerAgents.sh', '--claude']);
  assert.equal(sh.cwd, m.co);
  assert.match(sh.env?.PATH ?? '', /^\/home\/x\/\.local\/bin:/, "the daemon's Claude Code comes first on PATH");
  assert.equal(m.marker(), 'C:/Users/rydin/final-factory-agents\n', "publish-skills' marker still names the person's checkout");
  assert.deepEqual(m.lines.filter((l) => l.startsWith('Agent tools')), [
    'Agent tools before: ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord not installed',
    'Agent tools latest: final-factory-agents a8449abd8457: ff-agents 1.29.20, ff-speckit 1.0.2, ff-discord 1.17.7',
    'Agent tools after: ff-agents 1.29.20, ff-speckit 1.0.2, ff-discord not installed',
    'Agent tools published: every installed plugin is on master. Running agents keep the version they started with; new sessions load these.',
  ]);
  assert.ok(m.lines.includes('  == Claude Code =='), "registerAgents.sh's own output is passed on");
});

test('a later run fast-forwards its checkout and touches nothing else; with no marker before, the new one is reported', async () => {
  const m = machine({ existing: true });
  assert.equal(await m.run(), EXIT.ok);
  assert.equal(ran(m, 'clone').length, 0);
  assert.deepEqual(ran(m, 'fetch')[0].args.slice(-3), ['--quiet', 'origin', 'master']);
  assert.deepEqual(ran(m, 'merge')[0].args.slice(-3), ['--ff-only', '--quiet', 'origin/master'], 'a fast-forward only, never a reset');
  assert.ok(m.lines.some((l) => l.includes(`checkout marker now names ${m.co} (there was none)`)));
});

test('its checkout dirty, on another branch, from another repo or diverged: NOT PUBLISHED, nothing overwritten, registerAgents.sh not run', async () => {
  for (const [o, why] of [
    [{ porcelain: ' M plugins/ff-agents/skills/x/SKILL.md\n?? notes.txt\n' }, /has uncommitted changes \(2 paths\)/],
    [{ branch: 'w1258-ab-leg' }, /is on w1258-ab-leg, not master/],
    [{ origin: 'https://github.com/someone/fork.git' }, /has origin https:\/\/github\.com\/someone\/fork\.git, not/],
    [{ mergeCode: 128 }, /has commits origin\/master does not \(it cannot fast-forward\)/],
  ] as [Machine, RegExp][]) {
    const m = machine({ existing: true, ...o });
    assert.equal(await m.run(), EXIT.notPublished);
    assert.match(m.lines.find((l) => l.startsWith('NOT PUBLISHED:'))!, why);
    assert.match(m.lines.find((l) => l.startsWith('NOT PUBLISHED:'))!, /nothing in it was overwritten/);
    assert.ok(m.lines.includes('Agent tools after: ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord not installed (unchanged)'));
    assert.equal(m.calls.filter((c) => c.cmd === 'sh').length, 0);
    assert.equal(ran(m, 'reset').length + ran(m, 'stash').length + ran(m, 'checkout').length + ran(m, 'clean').length, 0);
  }
});

test('a folder in the way that is not a checkout is left alone', async () => {
  const m = machine();
  fs.mkdirSync(m.co, { recursive: true });
  fs.writeFileSync(path.join(m.co, 'keep.txt'), 'x');
  assert.equal(await m.run(), EXIT.notPublished);
  assert.equal(fs.readFileSync(path.join(m.co, 'keep.txt'), 'utf8'), 'x');
  assert.equal(ran(m, 'clone').length, 0);
});

test('a fetch or registerAgents.sh failure, or a plugin left behind master, fails and says which', async () => {
  const f = machine({ existing: true, fetchCode: 128 });
  assert.equal(await f.run(), EXIT.failed);
  assert.match(f.lines.at(-1)!, /^FAILED: could not fetch final-factory-agents \(fatal: unable to access\)/);
  const s = machine({ shCode: 1, installs: { 'ff-agents': '1.29.19', 'ff-speckit': '1.0.2' } });
  assert.equal(await s.run(), EXIT.failed);
  assert.match(s.lines.at(-1)!, /^FAILED: registerAgents\.sh exited 1: claude CLI not on PATH/);
  assert.ok(s.lines.includes('Agent tools after: ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord not installed'), 'the versions after are still read');
  const st = machine({ installs: { 'ff-agents': '1.29.20', 'ff-discord': '1.17.6' } });
  assert.equal(await st.run(), EXIT.failed);
  assert.match(st.lines.at(-1)!, /^FAILED: not on master's version after registerAgents\.sh: ff-speckit not installed \(master: 1\.0\.2\), ff-discord 1\.17\.6 \(master: 1\.17\.7\)\./);
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
