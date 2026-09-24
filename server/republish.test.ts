import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.ts';

/**
 * scripts/republish-public.ps1 end to end, the REAL path as well as the dry run, against a fake GitHub:
 * bare repos under <tmp>/github reached through git's url.insteadOf, and a fake `gh` (repo info, rename,
 * create, vulnerability reporting) first on PATH. The test plays the supervisor: it answers the script's
 * restart.request by running the real scripts/update-steps.ps1. The first real run failed on a path the
 * dry run never took (a CR in a ref name); this keeps both paths exercised.
 */

const FAKE_GH = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const hub = process.env.FAKE_HUB;
const a = process.argv.slice(2);
const meta = (slug) => path.join(hub, slug + '.json');
const read = (slug) => (fs.existsSync(meta(slug)) ? JSON.parse(fs.readFileSync(meta(slug), 'utf8')) : undefined);
const write = (slug, m) => fs.writeFileSync(meta(slug), JSON.stringify(m));
const redirects = path.join(hub, 'redirects.json');
const redirect = (slug) => (fs.existsSync(redirects) ? JSON.parse(fs.readFileSync(redirects, 'utf8'))[slug] : undefined);
fs.appendFileSync(path.join(hub, 'gh.log'), a.join(' ') + '\n');
const notFound = () => { process.stderr.write('gh: Not Found (HTTP 404)\n'); process.exit(1); };
if (a[0] === 'auth') process.exit(0);
if (a[0] === 'api' && a[1] === 'user') { console.log('4242\nexample-bot'); process.exit(0); }
if (a[0] === 'api' && a[1] === '-X' && a[2] === 'PUT') {
  const slug = /^repos\/(.+)\/private-vulnerability-reporting$/.exec(a[3])[1];
  const m = read(slug); if (!m) notFound();
  write(slug, { ...m, pvr: true }); process.exit(0);
}
if (a[0] === 'api' && a[1].startsWith('repos/')) {
  let slug = a[1].slice(6); if (!read(slug)) slug = redirect(slug) ?? slug;
  const m = read(slug); if (!m) notFound();
  console.log(slug + '\n' + m.visibility); process.exit(0);
}
if (a[0] === 'repo' && a[1] === 'rename') {
  const from = a[a.indexOf('-R') + 1]; const to = from.split('/')[0] + '/' + a[2];
  if (!read(from) || read(to)) process.exit(1);
  fs.renameSync(path.join(hub, from + '.git'), path.join(hub, to + '.git'));
  write(to, read(from)); fs.rmSync(meta(from));
  fs.writeFileSync(redirects, JSON.stringify({ [from]: to })); process.exit(0);
}
if (a[0] === 'repo' && a[1] === 'create') {
  const slug = a[2]; if (read(slug)) process.exit(1);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(hub, slug + '.git')]);
  write(slug, { visibility: a.includes('--public') ? 'public' : 'private' });
  fs.rmSync(redirects, { force: true }); process.exit(0);
}
process.stderr.write('fake gh: unhandled ' + a.join(' ') + '\n'); process.exit(2);
`;

const onWindows = process.platform === 'win32';

test('republish: the dry run changes nothing; the real run publishes, moves the checkout, and resumes cleanly', { skip: !onWindows && 'Windows only', timeout: 240_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'republish-'));
  const children: ChildProcess[] = [];
  t.after(() => {
    for (const c of children) c.kill();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  });
  const hub = path.join(tmp, 'github');
  const bin = path.join(tmp, 'bin');
  const app = path.join(tmp, 'app');
  fs.mkdirSync(path.join(hub, 'Final-Factory'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh.mjs'), FAKE_GH);
  fs.writeFileSync(path.join(bin, 'gh.cmd'), '@node "%~dp0gh.mjs" %*\r\n');
  fs.writeFileSync(path.join(bin, 'gitleaks.cmd'), '@echo %* >> "%~dp0gitleaks.log"\r\n@exit /b 0\r\n');
  const hubUrl = 'file:///' + hub.replace(/\\/g, '/') + '/';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    FAKE_HUB: hub,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${hubUrl}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
    FFSB_REPUBLISH_POLL_SECONDS: '1',
    FFSB_TASK_NAME: 'ffsb-test-never-run',
  };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const bareOf = (slug: string) => path.join(hub, ...slug.split('/')) + '.git';
  const meta = (slug: string) => {
    const f = path.join(hub, ...slug.split('/')) + '.json';
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
  };

  // The private repo: two commits, and two stale public-main* branches (single root commits of an older tree).
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(app, 'web'));
  for (const f of ['common.ps1', 'republish-public.ps1', 'update-steps.ps1']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(app, 'scripts', f));
  const pkg = (name: string) => JSON.stringify({ name, version: '1.0.0', private: true, scripts: { build: 'node -e 0' } });
  const lock = (name: string) => JSON.stringify({ name, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name, version: '1.0.0' } } });
  fs.writeFileSync(path.join(app, 'package.json'), pkg('app'));
  fs.writeFileSync(path.join(app, 'package-lock.json'), lock('app'));
  fs.writeFileSync(path.join(app, 'web', 'package.json'), pkg('web'));
  fs.writeFileSync(path.join(app, 'web', 'package-lock.json'), lock('web'));
  fs.writeFileSync(path.join(app, '.gitignore'), 'data/\nnode_modules/\nconfig.json\n');
  fs.writeFileSync(path.join(app, 'README.md'), 'old\n');
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'add', '-A');
  git(app, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one');
  const stale = git(app, 'commit-tree', git(app, 'rev-parse', 'HEAD^{tree}'), '-m', 'stale squash');
  fs.writeFileSync(path.join(app, 'README.md'), 'A portal.\n');
  git(app, 'add', '-A');
  git(app, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'two');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bareOf('Final-Factory/ff-factory')], { env });
  fs.writeFileSync(path.join(hub, 'Final-Factory', 'ff-factory.json'), JSON.stringify({ visibility: 'private' }));
  git(app, 'remote', 'add', 'origin', 'https://github.com/Final-Factory/ff-factory.git');
  git(app, 'push', '-q', '-u', 'origin', 'main');
  git(app, 'push', '-q', 'origin', `${stale}:refs/heads/public-main`, `${stale}:refs/heads/public-main-old`);
  const privateMain = git(app, 'rev-parse', 'HEAD');
  const mainTree = git(app, 'rev-parse', 'HEAD^{tree}');
  fs.mkdirSync(path.join(app, 'data'));
  fs.writeFileSync(path.join(app, 'data', 'state.json'), '{"keep":true}');
  fs.writeFileSync(path.join(app, 'config.json'), '{}');

  const inbox = () => {
    const d = path.join(app, 'data', 'orchestrator-inbox');
    return fs.existsSync(d) ? fs.readdirSync(d).sort().map((n) => fs.readFileSync(path.join(d, n), 'utf8')) : [];
  };
  const run = (...args: string[]) =>
    new Promise<number>((resolve) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'scripts', 'republish-public.ps1'), ...args], { env, stdio: 'ignore' });
      children.push(p);
      p.on('exit', (code) => resolve(code ?? -1));
    });

  // Dry run: nothing changes on the fake GitHub, and nothing is left behind for the real run to pick up.
  assert.equal(await run('-DryRun'), 0, inbox().join('\n'));
  assert.match(inbox().at(-1)!, /^\[republish\] Dry run OK/);
  assert.equal(meta('Final-Factory/ff-factory')?.visibility, 'private');
  assert.equal(meta('Final-Factory/ff-factory-private'), undefined);
  assert.deepEqual(git(app, 'ls-remote', '--heads', 'origin').split('\n').map((l) => l.split('\t')[1]).sort(), ['refs/heads/main', 'refs/heads/public-main', 'refs/heads/public-main-old']);

  // Without a supervisor the real run stops before anything irreversible (the app update is its last step).
  assert.equal(await run(), 1);
  assert.match(inbox().at(-1)!, /FAILED.*no supervisor.*Nothing was changed on GitHub/, JSON.stringify(inbox().at(-1)));
  assert.equal(meta('Final-Factory/ff-factory')?.visibility, 'private');
  assert.equal(meta('Final-Factory/ff-factory-private'), undefined);

  // A stand-in supervisor: a process whose command line names supervise.ps1, and the update loop.
  const sup = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep 600 # supervise.ps1'], { stdio: 'ignore' });
  children.push(sup);
  fs.writeFileSync(path.join(app, 'data', 'supervisor.pid'), String(sup.pid));
  let updates = 0;
  const loop = setInterval(() => {
    const flag = path.join(app, 'data', 'restart.request');
    if (!fs.existsSync(flag)) return;
    const req = JSON.parse(fs.readFileSync(flag, 'utf8'));
    fs.rmSync(flag);
    assert.equal(req.update, true);
    const at = new Date().toISOString();
    let ok = true;
    let error: string | undefined;
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'scripts', 'update-steps.ps1')], { cwd: app, env, stdio: 'pipe' });
    } catch (e) {
      ok = false;
      error = String((e as { stdout?: Buffer }).stdout ?? e).slice(-800);
    }
    updates++;
    fs.writeFileSync(path.join(app, 'data', 'update.result.json'), JSON.stringify({ ok, at, error }));
  }, 300);
  t.after(() => clearInterval(loop));

  assert.equal(await run(), 0, inbox().join('\n'));
  assert.match(inbox().at(-1)!, /^\[republish\] Done\./);
  assert.equal(updates, 1);
  // The public repo: one root commit of the private main's tree, not by the local git identity.
  const pub = bareOf('Final-Factory/ff-factory');
  const pubMain = git(pub, 'rev-parse', 'main');
  assert.equal(git(pub, 'rev-list', '--count', 'main'), '1');
  assert.equal(git(pub, 'rev-parse', 'main^{tree}'), mainTree);
  assert.equal(git(pub, 'log', '-1', '--format=%an <%ae>', 'main'), 'Final Factory <4242+example-bot@users.noreply.github.com>');
  assert.equal(meta('Final-Factory/ff-factory')?.pvr, true);
  // The private repo keeps its history, and the squashed commit as a new branch beside the stale ones.
  const priv = bareOf('Final-Factory/ff-factory-private');
  assert.equal(git(priv, 'rev-parse', 'main'), privateMain);
  const branches = git(priv, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/public-main*').split('\n');
  assert.equal(branches.length, 3);
  assert.ok(branches.some((b) => b.startsWith('public-main-2') && b.endsWith(pubMain)), branches.join('; '));
  // This checkout: on the public history, the old HEAD kept, ignored state untouched.
  assert.equal(git(app, 'rev-parse', 'HEAD'), pubMain);
  assert.equal(git(app, 'rev-parse', git(app, 'branch', '--list', 'pre-republish-*', '--format=%(refname:short)')), privateMain);
  assert.equal(fs.readFileSync(path.join(app, 'data', 'state.json'), 'utf8'), '{"keep":true}');

  // A rerun finds everything done: no second update, no new branch, same main.
  assert.equal(await run(), 0, inbox().join('\n'));
  assert.equal(updates, 1);
  assert.equal(git(bareOf('Final-Factory/ff-factory'), 'rev-parse', 'main'), pubMain);
  assert.equal(git(priv, 'for-each-ref', 'refs/heads/public-main*').split('\n').length, 3);
});
