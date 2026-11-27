import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkoutFromBundle, checkPublished } from '../machine/selfUpdate.ts';
import { execFileSync } from 'node:child_process';
import { AGENTS_REPO_URL, BRANCH, legacyToolsCheckout, MARKETPLACE, marketplaceVersions, publishAgentTools, toolsCheckout } from '../server/agentTools.ts';
import { toolsResult } from '../server/machineRollout.ts';
import { gitExecFileSync } from '../server/safeGit.ts';
import { exec } from './worker/worker.ts';

/**
 * w5573 (lothsahn, before #1179 merged: "If we get that wrong we may be unable to update workers and have to manually
 * reinstall"): the update path, through the git fence (server/safeGit.ts), against real GitHub, on each OS CI runs (Linux
 * in ci.yml, Windows in windows.yml, .github/windows-tests.txt). Each leg is the real code a machine updates with:
 * - the installer's anonymous clone and fetch of ff-factory (scripts/worker/worker.ts exec, fenced);
 * - the daemon's self-update (machine/selfUpdate.ts, w5516): the portal's bundle (`bundle create <f> HEAD`,
 *   server/machineLink.ts) fetched into an install's src and checked out at the commit, which must be on the published
 *   main (a real fetch of github.com/Final-Factory/ff-factory), and a commit that is not refused;
 * - `worker.ts tools` (server/agentTools.ts): FF Factory's tools checkout cloned, then fetched and fast-forwarded, and
 *   registerAgents.sh started from a fresh clone of final-factory-agents (the script itself is replaced by a stand-in
 *   that records where it ran and installs master's versions: CI has no Claude Code).
 * It reaches github.com, so it runs on CI or with FF_NETWORK_TESTS=1, and is skipped elsewhere.
 */
const online = !!(process.env.CI || process.env.FF_NETWORK_TESTS);
const FF = 'https://github.com/Final-Factory/ff-factory.git';
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'w5573-update-'));
const plain = (cwd: string, ...a: string[]) => String(gitExecFileSync(['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true })).trim();
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const anon = ['-c', 'credential.helper=', '-c', 'credential.interactive=never'];

/**
 * w6141: the hosted runner sometimes cannot reach github.com at all (run 45864772073, macos-latest: "Failed to connect to
 * github.com port 443 after 10679 ms: Couldn't connect to server" on the first clone). These tests check the update path,
 * not the runner's network, so a leg that reaches GitHub is run again, up to twice after a short pause, when and only when
 * git says it never connected. Every other failure (a refusal, a missing ref, a fence error) stays fatal on its first try.
 */
const connectFailure = (text: string) => /Failed to connect to|Couldn't connect to server|Could not connect to server|Could not resolve host/i.test(text);
const RETRY_PAUSES_MS = [5_000, 15_000];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run an exec-style leg ({ code, stderr }) again after a pause while it failed on a connect error. */
async function retryExec<R extends { code: number; stderr: string }>(run: () => Promise<R>, pauses = RETRY_PAUSES_MS): Promise<R> {
  for (let i = 0; ; i++) {
    const r = await run();
    if (r.code === 0 || i >= pauses.length || !connectFailure(r.stderr)) return r;
    console.log(`w6141: git could not reach GitHub (${r.stderr.trim()}); trying again in ${pauses[i] / 1000} s`);
    await pause(pauses[i]);
  }
}

/** Run a leg that throws (a sync or async call) again after a pause while it threw a connect error. */
async function retryThrow<T>(run: () => T | Promise<T>, pauses = RETRY_PAUSES_MS): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      const err = e as Error & { stderr?: unknown };
      const text = `${err?.message ?? e}\n${err?.stderr ?? ''}`;
      if (i >= pauses.length || !connectFailure(text)) throw e;
      console.log(`w6141: git could not reach GitHub (${text.trim()}); trying again in ${pauses[i] / 1000} s`);
      await pause(pauses[i]);
    }
  }
}

test('w6141: only a connect failure is retried, at most twice; every other failure is fatal on its first try', async () => {
  for (const t of [
    "fatal: unable to access 'https://github.com/Final-Factory/ff-factory.git/': Failed to connect to github.com port 443 after 10679 ms: Couldn't connect to server",
    "fatal: unable to access 'https://github.com/Final-Factory/ff-factory.git/': Could not resolve host: github.com",
    "Couldn't connect to server",
    // Linux's newer curl (measured on biscuit, git clone https://127.0.0.1:9/x.git):
    "fatal: unable to access 'https://127.0.0.1:9/x.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Could not connect to server",
    'Could not connect to server',
  ]) assert.equal(connectFailure(t), true, t);
  for (const t of [
    "fatal: Remote branch nope not found in upstream origin",
    "fatal: repository 'https://github.com/Final-Factory/nope.git/' not found",
    "fatal: unable to access 'https://github.com/x.git/': The requested URL returned error: 403",
    "fatal: unable to access 'https://github.com/x.git/': Operation timed out after 300000 milliseconds",
    "fatal: unable to access 'https://github.com/x.git/': SSL certificate problem: unable to get local issuer certificate",
    'commit 0123456789ab is not on main at https://github.com/Final-Factory/ff-factory.git: refused, nothing was changed',
    '',
  ]) assert.equal(connectFailure(t), false, t);

  const fast = [0, 0];
  const connect = { code: 128, stderr: "fatal: unable to access 'https://github.com/x.git/': Failed to connect to github.com port 443" };
  const other = { code: 128, stderr: 'fatal: Remote branch nope not found in upstream origin' };
  const ok = { code: 0, stderr: '' };
  const seq = (rs: { code: number; stderr: string }[]) => { let n = 0; return { run: async () => rs[n++], calls: () => n }; };

  let s = seq([connect, ok]);
  assert.equal((await retryExec(s.run, fast)).code, 0, 'a connect failure then a success: retried');
  assert.equal(s.calls(), 2);
  s = seq([connect, connect, connect, ok]);
  assert.equal((await retryExec(s.run, fast)).stderr, connect.stderr, 'three connect failures: given up after the second retry');
  assert.equal(s.calls(), 3);
  s = seq([other, ok]);
  assert.equal((await retryExec(s.run, fast)).stderr, other.stderr, 'another failure: not retried');
  assert.equal(s.calls(), 1);
  s = seq([connect, other, ok]);
  assert.equal((await retryExec(s.run, fast)).stderr, other.stderr, 'a connect failure then another failure: that one is fatal');
  assert.equal(s.calls(), 2);

  let n = 0;
  assert.equal(await retryThrow(() => { if (n++ === 0) throw new Error('could not read main (Command failed: Could not resolve host: github.com)'); return 'ok'; }, fast), 'ok');
  assert.equal(n, 2, 'a thrown connect failure: retried');
  n = 0;
  await assert.rejects(retryThrow(async () => { n++; throw new Error('commit 0123 is not on main: refused'); }, fast), /is not on main/);
  assert.equal(n, 1, 'a thrown refusal: not retried');
  n = 0;
  await assert.rejects(retryThrow(() => { n++; throw Object.assign(new Error('Command failed: git clone'), { stderr: Buffer.from("Couldn't connect to server") }); }, fast), /Command failed/);
  assert.equal(n, 3, "a sync throw whose stderr says it never connected: tried three times, then thrown");
});

test('w5573: the installer clones and fetches ff-factory, and the daemon self-updates to a --ref commit, through the fence', { skip: !online && 'reaches github.com: CI or FF_NETWORK_TESTS=1', timeout: 10 * 60_000 }, async () => {
  const dir = scratch();
  try {
    const clone = path.join(dir, 'ff-factory');
    const c = await retryExec(() => exec('git', [...anon, 'clone', '--quiet', '--branch', 'main', FF, clone], { env, timeoutMs: 5 * 60_000 }));
    assert.equal(c.code, 0, `clone: ${c.stderr}`);
    const f = await retryExec(() => exec('git', [...anon, '-C', clone, 'fetch', '--quiet', 'origin', 'main'], { env, timeoutMs: 5 * 60_000 }));
    assert.equal(f.code, 0, `fetch: ${f.stderr}`);
    const commit = plain(clone, 'rev-parse', 'origin/main');

    // The portal's bundle, as server/machineLink.ts makes it: `bundle create <f> HEAD` at the commit.
    plain(clone, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit);
    const bundle = path.join(dir, 'portal.bundle');
    plain(clone, 'bundle', 'create', '--quiet', bundle, 'HEAD');

    const src = path.join(dir, 'app', 'src');
    await checkoutFromBundle(src, bundle, commit);
    assert.equal(plain(src, 'rev-parse', 'HEAD'), commit, 'the install is on the commit');
    await retryThrow(() => checkPublished(src, commit));

    plain(src, '-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'commit', '--quiet', '--allow-empty', '-m', 'not published');
    const unpublished = plain(src, 'rev-parse', 'HEAD');
    await assert.rejects(retryThrow(() => checkPublished(src, unpublished)), /is not on main/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w5573: worker.ts tools clones, then fast-forwards, the tools checkout and runs registerAgents.sh from a fresh clone, through the fence', { skip: !online && 'reaches github.com: CI or FF_NETWORK_TESTS=1', timeout: 10 * 60_000 }, async () => {
  const dir = scratch();
  try {
    const home = path.join(dir, 'home');
    const claudeDir = path.join(home, '.claude');
    const root = path.join(dir, 'root');
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const runs: { cwd: string; script: boolean }[] = [];
    const d = {
      // Git for real; the script's shell is replaced by a stand-in that installs master's versions where it ran.
      exec: async (cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) => {
        if (cmd === 'git') return retryExec(() => exec(cmd, args, o));
        const cwd = o.cwd ?? '';
        runs.push({ cwd, script: fs.existsSync(path.join(cwd, 'registerAgents.sh')) });
        const latest = marketplaceVersions(JSON.parse(fs.readFileSync(path.join(cwd, '.claude-plugin', 'marketplace.json'), 'utf8')));
        const plugins = Object.fromEntries(['ff-agents', 'ff-speckit'].map((p) => [`${p}@${MARKETPLACE}`, [{ scope: 'user', version: latest[p] }]]));
        fs.mkdirSync(path.join(claudeDir, 'plugins'), { recursive: true });
        fs.writeFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
        return { code: 0, stdout: '', stderr: '' };
      },
      say: (l: string) => lines.push(l),
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir },
      home,
      tmpdir: tmp,
      platform: process.platform,
    };
    const lines: string[] = [];
    for (const leg of ['clone', 'fetch']) {
      lines.length = 0;
      const code = await publishAgentTools(root, d);
      assert.equal(code, 0, `${leg}: ${lines.join('\n')}`);
      assert.ok(fs.existsSync(path.join(toolsCheckout(root), 'registerAgents.sh')), `${leg}: the tools checkout is there`);
    }
    assert.equal(runs.length, 2);
    for (const r of runs) {
      assert.ok(r.script, 'registerAgents.sh was in the folder it ran from');
      assert.ok(path.resolve(r.cwd).startsWith(path.resolve(tmp)), `it ran from a fresh clone, not the tools checkout: ${r.cwd}`);
    }
    assert.deepEqual(fs.readdirSync(tmp), [], 'the fresh clones are removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("w5597: an old-layout machine publishes from the new checkout; hooks and scripts planted where workers write never run, and the new checkout's own hooks are off", { skip: !online && 'reaches github.com: CI or FF_NETWORK_TESTS=1', timeout: 10 * 60_000 }, async () => {
  const dir = scratch();
  try {
    const home = path.join(dir, 'home');
    const claudeDir = path.join(home, '.claude');
    const root = path.join(dir, 'root');
    const planted = path.join(dir, 'planted');
    const hook = `#!/bin/sh\necho "$0" >> "${planted.split(path.sep).join('/')}"\n`;
    const plant = (gitDir: string) => {
      for (const h of ['post-checkout', 'post-merge', 'reference-transaction', 'pre-auto-gc', 'post-rewrite']) {
        fs.mkdirSync(path.join(gitDir, 'hooks'), { recursive: true });
        fs.writeFileSync(path.join(gitDir, 'hooks', h), hook, { mode: 0o755 });
      }
    };
    // The machine before w5597: FF Factory's checkout in <root>/tools, which a worker can write, and the marker naming it.
    const legacy = legacyToolsCheckout(root);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    await retryThrow(() => gitExecFileSync(['clone', '--quiet', '--depth', '1', '--branch', BRANCH, AGENTS_REPO_URL, legacy], { env, windowsHide: true, stdio: 'pipe' }));
    plant(path.join(legacy, '.git'));
    fs.writeFileSync(path.join(legacy, 'registerAgents.sh'), hook, { mode: 0o755 });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, `${MARKETPLACE}-checkout`), `${legacy}\n`);
    const runs: string[] = [];
    const lines: string[] = [];
    const d = {
      exec: async (cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) => {
        if (cmd === 'git') return retryExec(() => exec(cmd, args, o));
        const cwd = o.cwd ?? '';
        runs.push(cwd);
        const latest = marketplaceVersions(JSON.parse(fs.readFileSync(path.join(cwd, '.claude-plugin', 'marketplace.json'), 'utf8')));
        const plugins = Object.fromEntries(['ff-agents', 'ff-speckit'].map((p) => [`${p}@${MARKETPLACE}`, [{ scope: 'user', version: latest[p] }]]));
        fs.mkdirSync(path.join(claudeDir, 'plugins'), { recursive: true });
        fs.writeFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
        return { code: 0, stdout: '', stderr: '' };
      },
      say: (l: string) => lines.push(l),
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeDir },
      home,
      // No tmpdir, as the daemon runs it: the run's folder is made beside the new checkout.
      platform: process.platform,
    };
    const co = toolsCheckout(root);
    assert.equal(await publishAgentTools(root, d), 0, lines.join('\n'));
    assert.ok(fs.existsSync(path.join(co, '.git')), 'the new checkout is cloned');
    assert.equal(fs.existsSync(planted), false, `nothing planted in the old checkout ran: ${fs.existsSync(planted) ? fs.readFileSync(planted, 'utf8') : ''}`);
    assert.equal(fs.readFileSync(path.join(legacy, 'registerAgents.sh'), 'utf8'), hook, 'the old checkout is left as it is');
    assert.equal(fs.readFileSync(path.join(claudeDir, `${MARKETPLACE}-checkout`), 'utf8'), `${co}\n`, "publish-skills' marker moved");
    assert.equal(runs.length, 1);
    assert.ok(path.resolve(runs[0]).startsWith(path.resolve(path.dirname(co))), `the script ran from a fresh clone in ${path.dirname(co)}: ${runs[0]}`);
    assert.deepEqual(fs.readdirSync(path.dirname(co)), [MARKETPLACE], 'the run folder is removed');
    const t = toolsResult(0, lines.join('\n'));
    assert.equal(t.status, 'ok');
    assert.ok(t.before && t.after && t.latest && t.latestSha, `the rollout reads it: ${JSON.stringify(t)}`);
    assert.ok(t.checkout?.startsWith(`${co} at `) && /^[0-9a-f]{12}$/.test(t.checkout.slice(co.length + 4)), `checkout line: ${t.checkout}`);

    // The new checkout's own hooks: live for a plain git (the control), off for the publish's.
    const head = plain(co, 'rev-parse', 'HEAD');
    plant(path.join(co, '.git'));
    execFileSync('git', ['-C', co, 'reset', '--quiet', '--hard', 'HEAD~1'], { env, windowsHide: true });
    assert.ok(fs.existsSync(planted), 'control: a plain git runs the planted hook');
    fs.rmSync(planted);
    lines.length = 0;
    assert.equal(await publishAgentTools(root, d), 0, lines.join('\n'));
    // Fast-forwarded to the branch's tip: the clone's head or a later one, since the live repo may take a push while
    // this test runs (w5749: CI run 45659709342 failed when final-factory-agents moved on between the two clones).
    const now = plain(co, 'rev-parse', 'HEAD');
    assert.ok(now === head || plain(co, 'merge-base', head, now) === head, `fast-forwarded: ${lines.join('\n')}`);
    assert.equal(fs.existsSync(planted), false, `no hook ran in the publish's fetch and merge: ${fs.existsSync(planted) ? fs.readFileSync(planted, 'utf8') : ''}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
