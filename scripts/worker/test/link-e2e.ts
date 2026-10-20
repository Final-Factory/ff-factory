/**
 * Updates over the daemon's own link end to end (w1596, docs/worker-install.md "Updates over the daemon's link"), against
 * the throwaway portal, on a real Windows PC or Mac: the real installer, the real OS supervisor (a scheduled task, a
 * LaunchAgent), the real daemon and the real job outside it. Never against the live portal; the test root has its own
 * service name and its own job name, so it runs beside a real install and never touches it or its agents.
 *
 *   node scripts/worker/test/link-e2e.ts <scratch folder> [port=8795]
 *
 * The portal runs from a clone of this checkout with a commit of its own on top (B), so the install (from this checkout,
 * A) has something to update to; then a commit whose daemon exits at start (C), so the update has to be put back.
 * Each line PASS or FAIL (exit 1 on any FAIL):
 * - the daemon offers the update over its link, and the portal sees it;
 * - an update to B: the bundle checked and fetched, the job run as the OS's own, the daemon on B and seen online, restarted
 *   once, its job's task or LaunchAgent removed afterwards, no credential in the job's log;
 * - an update to C, whose daemon never comes back: the job puts B back by itself, and the portal sees B online again;
 * - a restart over the link: the supervisor starts the daemon again and it is back online;
 * - an unload over the link: the daemon's task or LaunchAgent is gone, the daemon offline, its files kept.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutOf } from '../worker.ts';

const [scratchArg, portArg = '8795'] = process.argv.slice(2);
if (!scratchArg) throw new Error('usage: node scripts/worker/test/link-e2e.ts <scratch folder> [port]');
const scratch = path.resolve(scratchArg);
const port = Number(portArg);
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const isWin = process.platform === 'win32';
const service = isWin ? 'FFWorkerLinkTest' : 'com.fffactory.linktest';
const node = [process.execPath, ...process.execArgv];
const elevated = isWin ? spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' }).status === 0 : false;
let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', ...a], { cwd, stdio: 'pipe' }).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
fs.mkdirSync(scratch, { recursive: true });
const root = path.join(scratch, 'root');
const l = layoutOf(root);

// A game repo of its own: no GitHub, no credential.
const game = path.join(scratch, 'game.git');
const work = path.join(scratch, 'game-work');
fs.mkdirSync(work);
git(work, 'init', '-q', '-b', 'develop');
fs.writeFileSync(path.join(work, 'README.md'), 'test game\n');
git(work, 'add', '-A');
git(work, 'commit', '-qm', 'init');
git(scratch, 'clone', '-q', '--bare', work, game);

// The portal's code: this checkout's commit (A) and one on top (B). The update goes to the portal's own commit.
const A = git(SRC, 'rev-parse', 'HEAD');
const P = path.join(scratch, 'portal-code');
git(scratch, 'clone', '-q', '--no-hardlinks', SRC, P);
git(P, 'checkout', '-q', '--detach', A);
fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(P, 'node_modules'), isWin ? 'junction' : 'dir');
fs.writeFileSync(path.join(P, 'machine', 'LINK_E2E'), 'B\n');
git(P, 'add', 'machine/LINK_E2E');
git(P, 'commit', '-qm', 'link-e2e: B');
const B = git(P, 'rev-parse', 'HEAD');

// Claude Code is a prerequisite the install checks, never used here (as update-e2e.ts).
// On Windows in the native install's folder (~\.local\bin): the update job runs as a scheduled task, without this
// process's PATH, and finds Claude Code where withStandardPaths looks (the CI runner has none; w1596's first Windows run).
if (isWin && spawnSync('where', ['claude'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
  const bin = path.join(os.homedir(), '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo 0.0.0 (Claude Code stand-in, link-e2e)\r\n');
  process.env.PATH = `${bin};${process.env.PATH}`;
}
if (!isWin) {
  const bin = path.join(os.homedir(), '.local', 'bin');
  const claude = path.join(bin, 'claude');
  if (!fs.existsSync(claude)) {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(claude, '#!/bin/sh\necho "0.0.0 (Claude Code stand-in, link-e2e)"\n', { mode: 0o755 });
  }
}

const portal = spawn(node[0], [...node.slice(1), path.join(P, 'scripts', 'worker', 'test', 'portal.ts'), path.join(scratch, 'portal'), String(port), 'wlink'], { stdio: ['ignore', 'pipe', 'inherit'] });
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
const driver = `http://127.0.0.1:${port + 1}`;
const credential = fs.readFileSync(path.join(scratch, 'portal', 'credential.txt'), 'utf8').trim();
const linkState = async () => (await (await fetch(`${driver}/link`)).json()) as { canLink: boolean; online: boolean; daemon: string | null };
const link = async (action: string, flags?: Record<string, number>) => (await (await fetch(`${driver}/link`, { method: 'POST', body: JSON.stringify({ action, flags }) })).json()) as { ok: boolean; error?: string; report?: { ok: boolean; rollback?: string; note?: string; before?: string; after?: string; log: string } };
const waitFor = async (what: string, cond: () => Promise<boolean>, ms = 120_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond().catch(() => false)) return true;
    await sleep(2000);
  }
  console.log(`(timed out waiting for ${what})`);
  return false;
};
const connects = () =>
  fs.existsSync(l.logs)
    ? fs.readdirSync(l.logs).reduce((n, f) => n + fs.readFileSync(path.join(l.logs, f), 'utf8').split('\n').filter((x) => /connected to|started the daemon/.test(x)).length, 0)
    : 0;
const version = () => fs.readFileSync(path.join(l.daemon, 'app', 'machine', 'VERSION'), 'utf8').trim();
const short = (sha: string) => sha.slice(0, 7);
const jobRegistered = () =>
  isWin
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `if (Get-ScheduledTask -TaskName '${service}Job' -ErrorAction SilentlyContinue) { 'yes' }`], { encoding: 'utf8', windowsHide: true }).stdout.includes('yes')
    : fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${service}.job.plist`));
const daemonRegistered = () =>
  isWin
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `if (Get-ScheduledTask -TaskName '${service}' -ErrorAction SilentlyContinue) { 'yes' }`], { encoding: 'utf8', windowsHide: true }).stdout.includes('yes')
    : fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${service}.plist`));
const jobLog = () => fs.readFileSync(path.join(l.daemon, 'logs', 'update-job.log'), 'utf8');

try {
  // 1. The install, from this checkout (A), as a person runs it, with no portal ssh (as a join now installs).
  const install = spawnSync(node[0], [...node.slice(1), path.join(SRC, 'scripts', 'worker', 'worker.ts'), 'install', '--root', root, '--portal-url', portalUrl, '--credential-stdin', '--max-sandboxes', '2', '--max-agents-per-sandbox', '1', '--max-unity', '1', '--service', service, '--repo-url', game, '--no-firewall', '--no-cleanup', '--no-ssh', '--no-dev-drive', '--unity-slots-dir', path.join(scratch, 'slots'), ...(elevated ? ['--owner', os.userInfo().username] : [])], { input: credential + '\n', encoding: 'utf8', timeout: 20 * 60_000 });
  process.stdout.write(install.stdout ?? '');
  process.stderr.write(install.stderr ?? '');
  check(install.status === 0, 'the test install (from A, no portal ssh)', `exit ${install.status}`);
  if (install.status !== 0) throw new Error('the install failed');
  check(await waitFor('the daemon to offer updates over its link', async () => (await linkState()).canLink), 'the daemon offers updates over its link, and the portal sees it');

  // 2. An update to the portal's commit (B), over the link.
  const before = connects();
  const up = await link('update');
  check(up.ok && !!up.report?.ok, 'an update to B over the link', up.error ?? up.report?.note ?? '');
  check(version().startsWith(short(B)), "the daemon's code is B", version());
  check(await waitFor('the portal to see B', async () => (await linkState()).daemon?.startsWith(short(B)) === true, 60_000), 'the portal sees the daemon online on B');
  check(connects() > before, 'the daemon restarted for it (a new connection in its log)', `${before} -> ${connects()}`);
  check(!jobLog().includes(credential) && !/ffm_wlink_[A-Za-z0-9_-]{20,}/.test(jobLog() + JSON.stringify(up)), "no credential in the job's log or report");
  check(/The portal sees wlink online running/.test(up.report?.log ?? ''), "the report carries the installer's own lines");
  check(await waitFor("the job's registration to go", async () => !jobRegistered(), 60_000), `the job's ${isWin ? 'task' : 'LaunchAgent'} is removed once reported`);

  // 3. An update to a commit whose daemon exits at start (C): the job puts B back by itself.
  const daemonTs = path.join(P, 'machine', 'daemon.ts');
  fs.writeFileSync(daemonTs, fs.readFileSync(daemonTs, 'utf8').replace("if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {", "if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {\n  console.error('link-e2e: this daemon exits at start');\n  process.exit(3);"));
  git(P, 'commit', '-qam', 'link-e2e: C, a daemon that exits at start');
  const C = git(P, 'rev-parse', 'HEAD');
  const bad = await link('update');
  check(bad.ok && bad.report?.ok === false, 'an update to C, whose daemon never comes back, is reported failed', bad.error ?? '');
  check(bad.report?.rollback === 'ok', 'its job put B back by itself', bad.report?.note ?? '');
  check(version().startsWith(short(B)), "the daemon's code is B again", version());
  check(fs.existsSync(path.join(l.daemon, 'app.failed', 'machine', 'VERSION')) && fs.readFileSync(path.join(l.daemon, 'app.failed', 'machine', 'VERSION'), 'utf8').trim().startsWith(short(C)), "C's code is kept aside in app.failed");
  check(await waitFor('the portal to see B again', async () => (await linkState()).daemon?.startsWith(short(B)) === true, 60_000), 'the portal sees the daemon online on B again');

  // 4. A restart over the link.
  const c0 = connects();
  const rs = await link('restart');
  check(rs.ok, 'a restart over the link is answered', rs.error ?? '');
  check(await waitFor('a new connection', async () => connects() > c0 && (await linkState()).online), 'the supervisor started the daemon again and it is back online');

  // 5. An unload over the link.
  const un = await link('uninstall');
  check(un.ok, 'an unload over the link is answered', un.error ?? '');
  check(await waitFor('the daemon offline', async () => !(await linkState()).online), 'the daemon is offline');
  check(await waitFor('its registration gone', async () => !daemonRegistered(), 60_000), `the daemon's ${isWin ? 'task' : 'LaunchAgent'} is gone`);
  check(fs.existsSync(path.join(l.daemon, 'app', 'machine', 'daemon.ts')) && fs.existsSync(l.token), 'its files are kept (the code, the credential)');
  check(await waitFor("the unload job's registration to go", async () => !jobRegistered(), 60_000), `the unload job removed its own ${isWin ? 'task' : 'LaunchAgent'}`);
} finally {
  // A failure's evidence, before the uninstall removes the root: the job's log and the daemon's.
  if (failed) {
    for (const f of ['update-job.log', 'daemon.log', 'daemon.err.log', 'supervisor.log']) {
      const file = path.join(l.daemon, 'logs', f);
      console.log(`\n== ${f} (the end)\n${fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-60).join('\n') : '(none)'}`);
    }
  }
  const un = spawnSync(node[0], [...node.slice(1), path.join(SRC, 'scripts', 'worker', 'worker.ts'), 'uninstall', '--root', root, '--yes', '--force'], { encoding: 'utf8' });
  console.log(`(uninstall of the test root: exit ${un.status})`);
  portal.kill();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
