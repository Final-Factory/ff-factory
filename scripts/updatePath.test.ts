import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkoutFromBundle, checkPublished } from '../machine/selfUpdate.ts';
import { MARKETPLACE, marketplaceVersions, publishAgentTools, toolsCheckout } from '../server/agentTools.ts';
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

test('w5573: the installer clones and fetches ff-factory, and the daemon self-updates to a --ref commit, through the fence', { skip: !online && 'reaches github.com: CI or FF_NETWORK_TESTS=1', timeout: 10 * 60_000 }, async () => {
  const dir = scratch();
  try {
    const clone = path.join(dir, 'ff-factory');
    const c = await exec('git', [...anon, 'clone', '--quiet', '--branch', 'main', FF, clone], { env, timeoutMs: 5 * 60_000 });
    assert.equal(c.code, 0, `clone: ${c.stderr}`);
    const f = await exec('git', [...anon, '-C', clone, 'fetch', '--quiet', 'origin', 'main'], { env, timeoutMs: 5 * 60_000 });
    assert.equal(f.code, 0, `fetch: ${f.stderr}`);
    const commit = plain(clone, 'rev-parse', 'origin/main');

    // The portal's bundle, as server/machineLink.ts makes it: `bundle create <f> HEAD` at the commit.
    plain(clone, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit);
    const bundle = path.join(dir, 'portal.bundle');
    plain(clone, 'bundle', 'create', '--quiet', bundle, 'HEAD');

    const src = path.join(dir, 'app', 'src');
    await checkoutFromBundle(src, bundle, commit);
    assert.equal(plain(src, 'rev-parse', 'HEAD'), commit, 'the install is on the commit');
    await checkPublished(src, commit);

    plain(src, '-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'commit', '--quiet', '--allow-empty', '-m', 'not published');
    const unpublished = plain(src, 'rev-parse', 'HEAD');
    await assert.rejects(checkPublished(src, unpublished), /is not on main/);
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
        if (cmd === 'git') return exec(cmd, args, o);
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
