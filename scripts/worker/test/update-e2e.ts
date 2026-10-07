/**
 * The worker update end to end (w613, docs/worker-install.md "Updating"), against the throwaway portal: install a test
 * root, tune it by hand as BEAST and m5 were, then update it the way the ops worker does over ssh, and check what the
 * update promises. Never against the live portal; the test root has its own service name, Unity slots mailbox and no
 * clean-up, so it runs beside a real install (docs/worker-install.md, "Testing").
 *
 *   node scripts/worker/test/update-e2e.ts <scratch folder> [port=8797]
 *
 * What it checks, each line PASS or FAIL (exit 1 on any FAIL):
 * - the update runs with no terminal and no input (stdin closed), as an ssh session does, through the OS wrapper
 *   (install.sh --update / install.ps1 -Update); on Windows it also runs elevated when this process is (CI's runner is);
 * - it fetches nothing of the game repo: the root clone's origin points nowhere and no credential helper answers;
 * - every setting tuned in daemon.json by hand is carried, and the credential file is the same bytes, never printed;
 * - a Mac's LaunchAgent PATH keeps its order;
 * - the daemon restarted (a new connection in its log) and the portal sees it online with the new code;
 * - (w629) it runs with an ssh session's minimal PATH, with no Homebrew or Git folder on it: the installer finds git,
 *   git-lfs and node in their standard places itself (m5's ssh PATH had no /opt/homebrew/bin);
 * - (w629) an update refused by a prerequisite leaves the daemon untouched (no restart, its code as it was) and exits
 *   non-zero with the reason.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutOf } from '../worker.ts';
import { plistPathOf, withPlistPath } from '../worker.ts';

const [scratchArg, portArg = '8797'] = process.argv.slice(2);
if (!scratchArg) throw new Error('usage: node scripts/worker/test/update-e2e.ts <scratch folder> [port]');
const scratch = path.resolve(scratchArg);
const port = Number(portArg);
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const isWin = process.platform === 'win32';
const service = isWin ? 'FFWorkerUpdateTest' : 'com.fffactory.updatetest';
const node = [process.execPath, ...process.execArgv];
const elevated = isWin ? spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' }).status === 0 : false;
let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', ...a], { cwd, stdio: 'pipe' }).toString();

fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
fs.mkdirSync(scratch, { recursive: true });
const root = path.join(scratch, 'root');
const l = layoutOf(root);

// A game repo of its own (a local bare repo with a develop branch): no GitHub, no credential.
const game = path.join(scratch, 'game.git');
const work = path.join(scratch, 'game-work');
fs.mkdirSync(work);
git(work, 'init', '-q', '-b', 'develop');
fs.writeFileSync(path.join(work, 'README.md'), 'test game\n');
git(work, 'add', '-A');
git(work, 'commit', '-qm', 'init');
git(scratch, 'clone', '-q', '--bare', work, game);

// Claude Code is a prerequisite the install checks, never used here: a stand-in where the probe looks, when none is there.
if (isWin && spawnSync('where', ['claude'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
  // The probe takes a claude on PATH as an npm shim (machineDeployWin probeScript): one in a folder first on this PATH.
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo 0.0.0 (Claude Code stand-in, update-e2e)\r\n');
  process.env.PATH = `${bin};${process.env.PATH}`;
}
if (!isWin) {
  const bin = path.join(os.homedir(), '.local', 'bin');
  const claude = path.join(bin, 'claude');
  if (!fs.existsSync(claude)) {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(claude, '#!/bin/sh\necho "0.0.0 (Claude Code stand-in, update-e2e)"\n', { mode: 0o755 });
  }
}

// The throwaway portal.
const portal = spawn(node[0], [...node.slice(1), path.join(SRC, 'scripts', 'worker', 'test', 'portal.ts'), path.join(scratch, 'portal'), String(port), 'wupd'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('the test portal did not start in 60 s')), 60_000);
  portal.stdout!.on('data', (d: Buffer) => {
    process.stdout.write(d);
    if (String(d).includes('test portal on')) {
      clearTimeout(t);
      resolve();
    }
  });
  portal.on('exit', (c) => reject(new Error(`the test portal exited ${c}`)));
});
const portalUrl = `http://127.0.0.1:${port}`;
const credential = fs.readFileSync(path.join(scratch, 'portal', 'credential.txt'), 'utf8').trim();
const machine = async () => (await (await fetch(`http://127.0.0.1:${port + 1}/machine`)).json()) as { online?: boolean } | null;

/**
 * PATH as a non-interactive ssh session has it (w629): the system folders and the folder node is in, nothing else. m5's
 * `ssh benryding@m5` PATH was /usr/bin:/bin:/usr/sbin:/sbin; Windows' OpenSSH gives the system PATH, here without Git's.
 */
const sshPath = isWin
  ? [path.dirname(process.execPath), ...(fs.existsSync(path.join(scratch, 'bin')) ? [path.join(scratch, 'bin')] : []), path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.env.SystemRoot ?? 'C:\\Windows', path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'), path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'Wbem')].join(';')
  : [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const run = (args: string[], input?: string, env: NodeJS.ProcessEnv = {}) => {
  const base: NodeJS.ProcessEnv = { ...process.env };
  // Windows spells it Path: one PATH only, or the child may read either.
  if (env.PATH !== undefined) for (const k of Object.keys(base)) if (k.toLowerCase() === 'path') delete base[k];
  const r = spawnSync(args[0], args.slice(1), { input, encoding: 'utf8', timeout: 20 * 60_000, env: { ...base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...env } });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

try {
  // 1. The install, as a person runs it the first time.
  const installArgs = [...node, path.join(SRC, 'scripts', 'worker', 'worker.ts'), 'install', '--root', root, '--portal-url', portalUrl, '--credential-stdin', '--max-sandboxes', '2', '--max-agents-per-sandbox', '1', '--max-unity', '1', '--service', service, '--repo-url', game, '--no-firewall', '--no-cleanup', '--no-ssh', '--unity-slots-dir', path.join(scratch, 'slots'), ...(elevated ? ['--owner', os.userInfo().username] : [])];
  const inst = run(installArgs, credential + '\n');
  check(inst.code === 0, 'the test install', `exit ${inst.code}`);
  if (inst.code !== 0) throw new Error('the install failed; nothing to update');

  // 2. Tuned by hand, as BEAST's was: an agent total, protected paths, the editors' priority, the disk guard.
  const cfgFile = path.join(l.daemon, 'daemon.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as Record<string, any>;
  cfg.protectedPaths = [path.join(scratch, 'live-checkout')];
  cfg.hostGuard = { warnFreeGB: 1, criticalFreeGB: 1 };
  cfg.sandboxes = { ...cfg.sandboxes, maxAgents: 3, editorPriority: 'BelowNormal', diskWarnGB: 2, diskCriticalGB: 1, librarySeed: path.join(scratch, 'seed', 'Library') };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const tokenHash = crypto.createHash('sha256').update(fs.readFileSync(l.token)).digest('hex');
  let plistFile = '';
  let oldPath = '';
  if (!isWin) {
    // m5's PATH had ~/.unity/bin early, where the ssh session's probe does not see it.
    plistFile = path.join(os.homedir(), 'Library', 'LaunchAgents', `${service}.plist`);
    const text = fs.readFileSync(plistFile, 'utf8');
    const dirs = plistPathOf(text)!.split(':');
    oldPath = [dirs[0], path.join(os.homedir(), '.unity', 'bin'), ...dirs.slice(1)].join(':');
    fs.writeFileSync(plistFile, withPlistPath(text, oldPath));
  }
  // No game-repo fetch: its origin points nowhere and nothing could answer for a credential.
  git(l.repo, 'remote', 'set-url', 'origin', 'https://127.0.0.1:9/private/FinalFactory.git');
  // A start of the daemon: launchd appends to daemon.log on a Mac; on Windows each start rewrites daemon.log and the
  // supervisor appends "started the daemon" to its own log. So every log in the folder, both kinds of line.
  const connects = () =>
    fs.existsSync(l.logs)
      ? fs.readdirSync(l.logs).reduce((n, f) => n + fs.readFileSync(path.join(l.logs, f), 'utf8').split('\n').filter((x) => /connected to|started the daemon/.test(x)).length, 0)
      : 0;
  const before = connects();

  // 3. The update, as the ops worker runs it over ssh: the OS wrapper, no terminal, stdin closed, nothing asked.
  const wrapper = isWin
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SRC, 'scripts', 'worker', 'install.ps1'), '-Update', '-Root', root, '-Source', SRC]
    : ['bash', path.join(SRC, 'scripts', 'worker', 'install.sh'), '--update', '--root', root, '--source', SRC];
  // (w629) A prerequisite fails: the daemon is left as it is. An out-of-range limit is a refusal the preflight makes on
  // any computer; it stands for m5's missing git-lfs.
  const startsBefore = connects();
  const versionFile = path.join(l.daemon, 'app', 'machine', 'VERSION');
  const codeBefore = fs.readFileSync(versionFile, 'utf8');
  const refused = run([...wrapper, ...(isWin ? ['-MaxSandboxes', '99'] : ['--max-sandboxes', '99'])], undefined, { PATH: sshPath });
  check(refused.code === 2, 'an update a prerequisite refuses exits non-zero', `exit ${refused.code}`);
  check(/Not updating: .*the daemon was not touched/.test(refused.out) && /--max-sandboxes must be a whole number/.test(refused.out), 'it says why, and that the daemon was not touched');
  check(connects() === startsBefore, 'the refused update did not stop or restart the daemon', `${startsBefore} -> ${connects()}`);
  check(fs.readFileSync(versionFile, 'utf8') === codeBefore, "the refused update left the daemon's code as it was");
  check(!/The portal sees wupd online running/.test(refused.out), 'the refused update reports no success');

  // 3b. The update itself, with an ssh session's minimal PATH (w629).
  const upd = run(wrapper, undefined, { PATH: sshPath });
  check(upd.code === 0, `the update through ${isWin ? 'install.ps1 -Update' : 'install.sh --update'}, no terminal${elevated ? ', elevated' : ''}, an ssh session's PATH`, `exit ${upd.code}`);
  check(/the commit installed, not outdated/.test(upd.out), 'success only with the portal seeing the commit installed');
  check(!upd.out.includes(credential) && !/ffm_wupd_[A-Za-z0-9_-]{20,}/.test(upd.out), 'the credential is never printed');
  check(/Kept the root's clone of the game repo as it is \(no fetch/.test(upd.out), 'no fetch of the game repo');
  check(/Credential: the machine's own/.test(upd.out), 'it says the credential was reused');

  // 4. What was carried.
  const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as Record<string, any>;
  check(JSON.stringify(after.protectedPaths) === JSON.stringify(cfg.protectedPaths), 'protected paths carried');
  check(JSON.stringify(after.hostGuard) === JSON.stringify(cfg.hostGuard), 'the host guard carried');
  check(after.sandboxes?.maxAgents === 3 && after.sandboxes?.editorPriority === 'BelowNormal' && after.sandboxes?.diskWarnGB === 2, 'the pool settings carried (agent total, editor priority, disk guard)', JSON.stringify(after.sandboxes));
  check(after.sandboxes?.librarySeed === cfg.sandboxes.librarySeed, 'the Library seed carried');
  check([after.sandboxes?.maxSandboxes, after.sandboxes?.maxAgentsPerSandbox, after.sandboxes?.maxUnity].join() === '2,1,1', 'the one-root limits kept');
  check(crypto.createHash('sha256').update(fs.readFileSync(l.token)).digest('hex') === tokenHash, 'the credential file is the same bytes');
  if (!isWin) check((plistPathOf(fs.readFileSync(plistFile, 'utf8')) ?? '').startsWith(oldPath), "the LaunchAgent's PATH keeps its order", plistPathOf(fs.readFileSync(plistFile, 'utf8')));

  // 5. Restarted and seen.
  check(connects() > before, 'the daemon restarted (a new connection in its log)', `${before} -> ${connects()}`);
  check(!!(await machine())?.online, 'the portal sees it online');
  check(/The portal sees wupd online/.test(upd.out), 'the update says the portal sees it online');

  // 6. Safe to re-run.
  const again = run(wrapper);
  check(again.code === 0 && /Settings: none changed/.test(again.out), 'a second update changes no setting', `exit ${again.code}`);
} finally {
  git(l.repo, 'remote', 'set-url', 'origin', game);
  const un = run([...node, path.join(SRC, 'scripts', 'worker', 'worker.ts'), 'uninstall', '--root', root, '--yes', '--force']);
  console.log(`(uninstall of the test root: exit ${un.code})`);
  portal.kill();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
