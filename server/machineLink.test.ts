// Updates, restarts and unloads over the daemon's own link (w1596, docs/worker-install.md "Updates over the daemon's link"):
// a real daemon and portal over real WebSockets. The portal's code is a small git repo here; the job the daemon starts as the
// OS's own is a stand-in that writes what scripts/worker/linkJob.ts writes (scripts/worker/linkJob.test.ts tests that job).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { PendingCalls, UpdateBundles, updateBundleFor } from './machineLink.ts';
import type { LinkUpdateReport } from './machineProtocol.ts';
import { Daemon, RECONNECT_MS, type DaemonConfig, type Probes } from '../machine/daemon.ts';
import { checkoutFromBundle, downloadBundle, readJson, selfUpdateProblem, updateFiles, writeJson, type UpdateJob } from '../machine/selfUpdate.ts';
import type { JobSpec } from '../machine/osJob.ts';
import type { Config } from './config.ts';

const PROBES: Probes = {
  stats: async () => ({ hostname: 'mx', platform: 'darwin', cpuCount: 1, cpuModel: 'x', loadPct: 0, memTotalBytes: 2 ** 30, memFreeBytes: 2 ** 30 }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

const until = async (what: string, cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', '-c', 'init.defaultBranch=main', ...a], { cwd, stdio: 'pipe' }).toString().trim();

/** The portal's code: a git repo with the update job in it, at a commit. */
function portalRepo(dir: string, text = 'one'): { root: string; commit: string } {
  fs.mkdirSync(path.join(dir, 'scripts', 'worker'), { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'scripts', 'worker', 'linkJob.ts'), `// stand-in ${text}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', text);
  return { root: dir, commit: git(dir, 'rev-parse', 'HEAD') };
}

async function setup(t: { after: (fn: () => unknown) => void }, o: { root?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-link-'));
  const cfg = { dataDir: path.join(tmp, 'data'), limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' } } as unknown as Config;
  fs.mkdirSync(cfg.dataDir);
  const store = new Store(cfg.dataDir);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  const repo = portalRepo(path.join(tmp, 'portal'));
  mm.bundles = new UpdateBundles({ dataDir: cfg.dataDir, root: repo.root });
  const server = http.createServer(async (req, res) => {
    // As server/index.ts serves it.
    const r = await updateBundleFor(new URL(req.url ?? '/', 'http://x').pathname, () => mm.authenticate(req.headers.authorization), mm.bundles);
    if (!r) return void res.writeHead(404).end();
    if (r.status !== 200) return void res.writeHead(r.status).end(r.error);
    res.writeHead(200, { 'content-length': r.size });
    fs.createReadStream(r.file).pipe(res);
  });
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'mx', host: 'mx', purpose: 'unused', status: 'ready', repoPath: tmp, home: tmp, portalUrl: url });
  const root = path.join(tmp, 'root');
  fs.mkdirSync(root);
  if (o.root !== false) fs.writeFileSync(path.join(root, 'root.json'), JSON.stringify({ machineId: 'mx', service: 'com.fffactory.linktest', platform: process.platform }));
  const appDir = path.join(root, 'daemon');
  const config: DaemonConfig = { portalUrl: url, id: 'mx', token, repoPath: tmp, ...(o.root !== false ? { root } : {}), appDir, claude: 'no-such-claude', maxEventsFile: null, cleanup: { everyMinutes: 0 } } as DaemonConfig;
  RECONNECT_MS.value = 200;
  const d = new Daemon(config, undefined, PROBES);
  const launched: JobSpec[] = [];
  const exits: number[] = [];
  d.exitForRestart = () => exits.push(Date.now());
  d.start();
  t.after(async () => {
    RECONNECT_MS.value = 2000;
    d.shutdown();
    server.close();
    await until('the daemon gone', () => !mm.isOnline('mx'), 5000).catch(() => undefined);
    store.flush();
    await store.saved();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { tmp, mm, d, repo, token, url, root, appDir, launched, exits };
}

/** The job stand-in: records how it was started, and ends as linkJob.ts does, with a result for the daemon to send. */
const finishing = (s: Awaited<ReturnType<typeof setup>>, outcome: Partial<LinkUpdateReport>) => async (spec: JobSpec) => {
  s.launched.push(spec);
  const f = updateFiles(s.appDir);
  const job = readJson<UpdateJob>(f.job)!;
  setTimeout(() => {
    writeJson(f.result, { id: job.id, form: job.form === 'tools' ? 'tools' : 'update', commit: job.commit ?? '', ok: true, exit: 0, log: 'Before: daemon x\nAfter: daemon y\n', at: new Date().toISOString(), ...outcome });
    writeJson(f.job, { ...job, phase: 'done' });
    void s.d.selfUpdate.tick();
  }, 50);
  return 'the stand-in job';
};

test('w1596: a worker install says it updates over its link; the portal sends the update, the daemon checks the bundle, checks the commit out and starts the job; the report comes back', async (t) => {
  const s = await setup(t);
  await until('online, its hello read', () => s.mm.canLink('mx'));
  s.d.selfUpdate.deps.launch = finishing(s, {});
  const removed: string[] = [];
  s.d.selfUpdate.deps.remove = async (service) => void removed.push(service);
  const r = await s.mm.linkUpdate('mx', { flags: { maxUnity: 2 } });
  assert.equal(r.ok, true);
  assert.equal(r.commit, s.repo.commit);
  const f = updateFiles(s.appDir);
  assert.equal(git(f.src, 'rev-parse', 'HEAD'), s.repo.commit, "the install's checkout is at the portal's commit");
  const job = readJson<UpdateJob>(f.job)!;
  assert.deepEqual([job.form, job.commit, job.flags, job.service, job.root], ['update', s.repo.commit, { maxUnity: 2 }, 'com.fffactory.linktest', s.root]);
  assert.equal(job.reported, true, 'the daemon marked the report sent');
  await s.d.selfUpdate.tick();
  assert.deepEqual(removed, ['com.fffactory.linktest'], "the ended job's task or LaunchAgent is removed once reported");
  assert.equal(readJson<UpdateJob>(f.job)?.removed, true);
  const spec = s.launched[0];
  assert.equal(spec.service, 'com.fffactory.linktest');
  assert.deepEqual(spec.args.slice(-3), [path.join(f.src, 'scripts', 'worker', 'linkJob.ts'), '--job', f.job], 'the job runs linkJob.ts from the checked-out commit');

  // A second update while one is in flight is refused by the daemon, and nothing changes.
  writeJson(f.job, { ...job, phase: 'staged', reported: false });
  await assert.rejects(s.mm.linkUpdate('mx'), /mx refused it: an update job of this machine is still running/);
  writeJson(f.job, { ...job, phase: 'done' });

  // A failed update whose job put the old code back: the report says so.
  s.d.selfUpdate.deps.launch = finishing(s, { ok: false, exit: 1, rollback: 'ok', note: 'the new daemon did not come back healthy, so the job put abc back' });
  const bad = await s.mm.linkUpdate('mx');
  assert.equal(bad.ok, false);
  assert.equal(bad.rollback, 'ok');
});

test('w1596: the bundle goes only to the machine it was offered to, with its own credential; a wrong size, SHA-256 or commit changes nothing', async (t) => {
  const s = await setup(t);
  await until('online', () => s.mm.canLink('mx'));
  const b = await s.mm.bundles.prepare();
  const sha = createHash('sha256').update(fs.readFileSync(b.file)).digest('hex');
  assert.equal(b.sha256, sha);
  assert.equal(b.commit, s.repo.commit);
  const get = (token: string, h = sha) => fetch(`${s.url}/machine/update/${h}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await get(s.token)).status, 404, 'not offered yet');
  s.mm.bundles.offer('mx', b);
  assert.equal((await get('ffm_mx_' + 'x'.repeat(40))).status, 401, 'another credential');
  assert.equal((await get(s.token, 'f'.repeat(64))).status, 404, 'another bundle');
  const ok = await get(s.token);
  assert.equal(ok.status, 200);
  await ok.arrayBuffer();

  const dir = path.join(s.tmp, 'dl');
  await assert.rejects(downloadBundle(s.url, s.token, { sha256: b.sha256, size: b.size - 1 }, dir), /larger than the .* bytes the portal said/);
  await assert.rejects(downloadBundle(s.url, s.token, { sha256: b.sha256, size: b.size + 1 }, dir), /does not match what the portal said on the link/);
  const file = await downloadBundle(s.url, s.token, b, dir);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.part')).length, 0, 'no part file left');

  const src = path.join(s.tmp, 'src');
  const other = portalRepo(path.join(s.tmp, 'portal2'), 'two');
  await assert.rejects(checkoutFromBundle(src, file, other.commit), /holds commit .*, not .* as the portal said/);
  await checkoutFromBundle(src, file, s.repo.commit);
  assert.equal(git(src, 'rev-parse', 'HEAD'), s.repo.commit);
  fs.writeFileSync(path.join(s.tmp, 'junk.bundle'), 'not a bundle');
  await assert.rejects(checkoutFromBundle(src, path.join(s.tmp, 'junk.bundle'), s.repo.commit), /not one git can read/);

  assert.match(selfUpdateProblem({ commit: 'abc', bundle: { sha256: sha, size: 1 } }) ?? '', /full git commit/);
  assert.match(selfUpdateProblem({ commit: s.repo.commit, bundle: { sha256: 'x', size: 1 } }) ?? '', /SHA-256/);
  assert.match(selfUpdateProblem({ commit: s.repo.commit, bundle: { sha256: sha, size: 0 } }) ?? '', /size/);
  assert.equal(selfUpdateProblem({ commit: s.repo.commit, bundle: { sha256: sha, size: 10 } }), undefined);

  // The portal moved on (its checkout at another commit than a rollout asked for): no bundle.
  await assert.rejects(s.mm.bundles.prepare('0'.repeat(40)), /checkout is at .*, not 000000000000/);
});

test('w1596: a restart over the link answers, then the daemon exits for its supervisor; an unload starts its job; a daemon outside a worker root is not sent either', async (t) => {
  const s = await setup(t);
  await until('online', () => s.mm.canLink('mx'));
  await s.mm.linkControl('mx', 'restart');
  await until('the daemon exits', () => s.exits.length === 1, 3000);

  s.d.selfUpdate.deps.launch = async (spec) => {
    s.launched.push(spec);
    return 'the stand-in job';
  };
  // The install's checkout has the job only after an update put it there.
  await assert.rejects(s.mm.linkControl('mx', 'uninstall'), /has no update job/);
  fs.mkdirSync(path.join(updateFiles(s.appDir).src, 'scripts', 'worker'), { recursive: true });
  fs.writeFileSync(path.join(updateFiles(s.appDir).src, 'scripts', 'worker', 'linkJob.ts'), '');
  // A daemon just restarted after a job removes that job's task at its first tick, as the next command arrives (w1596's
  // Windows CI run: "refused it: an update job of this machine is still running"): the unload waits for it.
  const f = updateFiles(s.appDir);
  fs.mkdirSync(f.dir, { recursive: true });
  writeJson(f.job, { id: 'old', form: 'update', root: s.root, appDir: s.appDir, service: 'com.fffactory.linktest', createdAt: new Date().toISOString(), phase: 'done', reported: true });
  let removal = false;
  s.d.selfUpdate.deps.remove = async () => {
    removal = true;
    await new Promise((r) => setTimeout(r, 300));
  };
  const ticking = s.d.selfUpdate.tick();
  assert.equal(removal, true, 'the removal is under way');
  await s.mm.linkControl('mx', 'uninstall');
  await ticking;
  assert.equal(readJson<UpdateJob>(updateFiles(s.appDir).job)?.form, 'uninstall');
  assert.equal(s.launched.length, 1);

  const plain = await setup(t, { root: false });
  await until('online, its hello read', () => plain.mm.hasHello('mx'));
  assert.equal(plain.mm.canLink('mx'), false, 'no worker root: ssh, as before');
  await assert.rejects(plain.mm.linkUpdate('mx'), /does not update over its link/);
});

test('w1596: a call nobody answers times out with what it waited for', async () => {
  const p = new PendingCalls<true>();
  // Its timer does not hold a process open: this one does, for the test.
  const hold = setTimeout(() => undefined, 1000);
  await assert.rejects(p.wait('a', 'mx', 20, 'the restart'), /mx did not answer the restart in 1 minute/);
  clearTimeout(hold);
  const q = p.wait('b', 'mx', 5000, 'x');
  assert.equal(p.settle('b', true), true);
  assert.equal(await q, true);
  assert.equal(p.settle('b', true), false, 'answered once');
});
