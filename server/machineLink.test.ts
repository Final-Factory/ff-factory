// Updates, restarts and unloads over the daemon's own link (w1596, docs/worker-install.md "Updates over the daemon's link"):
// a real daemon and portal over real WebSockets. The portal's code is a small git repo here; the job the daemon starts as the
// OS's own is a stand-in that writes what scripts/worker/linkJob.ts writes (scripts/worker/linkJob.test.ts tests that job).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { PendingCalls, type UpdateBundle, UpdateBundles, bundleServedLine, unwaitedAnswer, updateBundleFor } from './machineLink.ts';
import type { FromDaemon, LinkUpdateReport } from './machineProtocol.ts';
import { Daemon, RECONNECT_MS, REOFFER_MS, type DaemonConfig, type Probes } from '../machine/daemon.ts';
import { ANSWERS, SelfUpdater, alive, checkPublished, checkoutFromBundle, downloadBundle, fetchError, inFlightRefusal, JOB_LIMIT, jobToEnd, keepRootJson, processCommand, readJson, rootBackupOf, selfUpdateProblem, updateFiles, writeJson, type UpdateJob } from '../machine/selfUpdate.ts';
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

async function setup(t: { after: (fn: () => unknown) => void }, o: { root?: boolean; record?: 'file' | 'spare' | 'none'; outside?: { kind: string; name: string }[]; detached?: boolean } = {}) {
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
  // w4672: 'detached' is a Dev Drive not attached at the daemon's start: the root cannot be made (a file holds its path), and
  // the daemon's folder is on the host volume, as on LothLaptop (D:\work\ffw\daemon beside V:\ffw).
  const appDir = o.detached ? path.join(tmp, 'host-daemon') : path.join(root, 'daemon');
  // w1918: 'spare' is a root on its Dev Drive whose drive came back empty: only the daemon folder's spare copy is left.
  const record = JSON.stringify({ machineId: 'mx', service: 'com.fffactory.linktest', platform: process.platform, devDrive: { vhdx: 'x.vhdx', letter: 'V', maxGB: 80, inUse: true, rootOnDrive: true, host: tmp }, ...(o.outside ? { outside: o.outside } : {}) });
  if (o.root !== false && (o.record ?? 'file') === 'file') fs.writeFileSync(path.join(root, 'root.json'), record);
  if (o.record === 'spare') {
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(rootBackupOf(appDir), record);
  }
  if (o.detached) {
    fs.rmSync(root, { recursive: true });
    fs.writeFileSync(root, 'not a drive');
  }
  const config: DaemonConfig = { portalUrl: url, id: 'mx', token, repoPath: tmp, ...(o.root !== false ? { root } : {}), appDir, claude: 'no-such-claude', maxEventsFile: null, cleanup: { everyMinutes: 0 }, updateOrigin: { url: repo.root, branch: git(repo.root, 'branch', '--show-current') } } as DaemonConfig;
  RECONNECT_MS.value = 200;
  REOFFER_MS.value = 200;
  const d = new Daemon(config, undefined, PROBES);
  const launched: JobSpec[] = [];
  const exits: number[] = [];
  d.exitForRestart = () => exits.push(Date.now());
  d.start();
  t.after(async () => {
    RECONNECT_MS.value = 2000;
    REOFFER_MS.value = 30_000;
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

/**
 * w5593: a daemon whose update stand-in job ran is updated again here, so its job's task is "removed" by a stub (the real one
 * starts PowerShell on Windows for each job: the w5642 review's 238-329 s), and each step waits for that clean-up's job.json write.
 */
async function thinSetup(t: { after: (fn: () => unknown) => void }) {
  const s = await setup(t);
  await until('online, its hello read', () => s.mm.canLink('mx'));
  s.d.selfUpdate.deps.launch = finishing(s, {});
  s.d.selfUpdate.deps.remove = async () => undefined;
  const offered: UpdateBundle[] = [];
  const offer = s.mm.bundles.offer.bind(s.mm.bundles);
  s.mm.bundles.offer = (id, b, now) => (offered.push(b), offer(id, b, now));
  const daemon = { runs: undefined as string | undefined };
  s.mm.daemonCommit = () => daemon.runs;
  const f = updateFiles(s.appDir);
  const update = async (form?: 'tools') => {
    const r = await s.mm.linkUpdate('mx', form ? { form } : {});
    // The daemon's own tick may be removing the job already (then this tick returns at once): wait for its job.json write.
    await s.d.selfUpdate.tick();
    await until('the ended job removed', () => readJson<UpdateJob>(f.job)?.removed === true);
    return r;
  };
  return { s, offered, daemon, update, f };
}

test('w5593: a machine gets only what its checkout lacks, from the commit its daemon runs; the tools run from HEAD\'s parents', async (t) => {
  const { s, offered, daemon, update, f } = await thinSetup(t);
  // A daemon that does not say its commit (or names one the portal lacks) gets the full bundle, as before.
  const one = s.repo.commit;
  daemon.runs = 'f'.repeat(40);
  assert.equal((await update()).ok, true);
  assert.equal(offered.at(-1)?.from, undefined, 'an unknown commit: the full bundle');
  const full1 = offered.at(-1)!;
  // The portal moved on, with a big file: the daemon on `one` (a short id in its hello) gets a bundle without what it has.
  fs.writeFileSync(path.join(s.repo.root, 'big.bin'), randomBytes(200_000));
  const two = portalRepo(s.repo.root, 'two').commit;
  daemon.runs = one.slice(0, 8);
  assert.equal((await update()).ok, true);
  assert.deepEqual([offered.at(-1)!.commit, offered.at(-1)!.from], [two, [one]]);
  assert.equal(git(f.src, 'rev-parse', 'HEAD'), two, 'checked out from the incremental bundle');
  const three = portalRepo(s.repo.root, 'three').commit;
  const full3 = await s.mm.bundles.prepare();
  daemon.runs = two;
  assert.equal((await update()).ok, true);
  assert.ok(offered.at(-1)!.size < full3.size / 10, `incremental ${offered.at(-1)!.size} bytes against the full ${full3.size}`);
  assert.equal(git(f.src, 'rev-parse', 'HEAD'), three);
  // The tools publish on a daemon that runs this commit already: from its parents.
  daemon.runs = three;
  assert.equal((await update('tools')).ok, true);
  assert.deepEqual(offered.at(-1)!.from, [two]);
  // Bundles of the current commit stay; of older ones only the newest.
  const left = fs.readdirSync(path.join(s.tmp, 'data', 'update-bundles')).filter((x) => x.endsWith('.bundle'));
  assert.equal(left.includes(path.basename(full1.file)), false, "the first commit's bundle is gone");
  assert.equal(left.filter((x) => x.startsWith(three.slice(0, 16))).length, 2, `both of three's bundles stay: ${left.join(', ')}`);
});

test('w5593: a checkout without the base refuses the incremental bundle and gets the full one in the same call', async (t) => {
  const { s, offered, daemon, update, f } = await thinSetup(t);
  const one = s.repo.commit;
  assert.equal((await update()).ok, true);
  // A machine installed another way, or a checkout made again: its daemon names `one`, its checkout lacks it.
  const two = portalRepo(s.repo.root, 'two').commit;
  daemon.runs = one;
  fs.rmSync(f.src, { recursive: true, force: true });
  const n = offered.length;
  assert.equal((await update()).ok, true);
  assert.deepEqual(offered.slice(n).map((b) => b.from), [[one], undefined], 'the incremental bundle, then the full one');
  assert.equal(git(f.src, 'rev-parse', 'HEAD'), two);
});

test('w5593: any other refusal (a job still running) is not mended by the full bundle: it is not sent', async (t) => {
  const { s, offered, daemon, update, f } = await thinSetup(t);
  const one = s.repo.commit;
  assert.equal((await update()).ok, true);
  portalRepo(s.repo.root, 'two');
  daemon.runs = one;
  writeJson(f.job, { ...readJson<UpdateJob>(f.job)!, phase: 'staged', reported: false });
  const n = offered.length;
  await assert.rejects(s.mm.linkUpdate('mx'), /mx refused it: an update job of this machine is still running/);
  assert.deepEqual(offered.slice(n).map((b) => b.from), [[one]], 'one offer, no fall back');
});

test('w5593: the incremental base: a merge HEAD leaves out every parent; a short id is resolved; a bad, unknown or diverged one, or a root HEAD, gets none', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-thin-'));
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const one = portalRepo(repo, 'one').commit;
    const b = new UpdateBundles({ dataDir: path.join(tmp, 'data'), root: repo });
    // A root commit as HEAD, on a daemon that runs it already: no parents to leave out.
    const root = await b.prepare();
    assert.equal(await b.thin(root, one), undefined, 'a root HEAD');
    const main = git(repo, 'branch', '--show-current');
    git(repo, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'side');
    const side = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', main);
    const two = portalRepo(repo, 'two').commit;
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'side');
    const merge = git(repo, 'rev-parse', 'HEAD');
    const full = await b.prepare();
    assert.equal(full.commit, merge);
    assert.deepEqual((await b.thin(full, merge))?.from, [two, side], 'a daemon on the merge: every parent left out');
    assert.deepEqual((await b.thin(full, one.slice(0, 7)))?.from, [one], 'a short id');
    for (const bad of [undefined, '', 'abc', 'not-a-sha', 'g'.repeat(40), '0'.repeat(40), `${one.slice(0, 7)}^`]) assert.equal(await b.thin(full, bad), undefined, `"${bad}"`);
    // A commit the portal has that HEAD does not descend from.
    git(repo, 'checkout', '-q', '-b', 'other', one);
    const other = portalRepo(repo, 'other').commit;
    git(repo, 'checkout', '-q', main);
    assert.equal(await b.thin(full, other), undefined, 'not behind HEAD');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
  assert.equal(s.mm.bundles.fetched('mx', b.sha256), false, 'w2005: not asked for yet');
  const ok = await get(s.token);
  assert.equal(ok.status, 200);
  await ok.arrayBuffer();
  assert.equal(s.mm.bundles.fetched('mx', b.sha256), true, 'w2005: asked for');
  s.mm.bundles.offer('mx', b);
  assert.equal(s.mm.bundles.fetched('mx', b.sha256), false, 'w2005: a new offer starts over');

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

  // w5516: the daemon takes a commit only when it is on the published branch, whatever the portal said.
  const branch = git(s.repo.root, 'branch', '--show-current');
  await checkPublished(src, s.repo.commit, { url: s.repo.root, branch });
  await assert.rejects(checkPublished(src, other.commit, { url: s.repo.root, branch }), /commit .* is not on .* refused, nothing was changed/);
  await assert.rejects(checkPublished(src, s.repo.commit, { url: path.join(s.tmp, 'nowhere'), branch }), /could not read .* nothing was changed/);
  await assert.rejects(checkPublished(src, s.repo.commit, { url: s.repo.root, branch: 'main;rm' }), /not a branch name/);
  const before = git(src, 'rev-parse', 'HEAD');
  const unpublished = portalRepo(path.join(s.tmp, 'portal3'), 'three');
  const ub = path.join(s.tmp, 'unpublished.bundle');
  git(unpublished.root, 'bundle', 'create', '-q', ub, 'HEAD');
  await assert.rejects(checkoutFromBundle(src, ub, unpublished.commit, (dir) => checkPublished(dir, unpublished.commit, { url: s.repo.root, branch })), /is not on/);
  assert.equal(git(src, 'rev-parse', 'HEAD'), before, 'an unpublished commit is never checked out');

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

test('w1918: root.json gone with a reset drive: the daemon puts it back from its spare copy and offers updates; with neither, the portal says why and sends nothing to ssh', async (t) => {
  // The drive came back empty: the daemon puts root.json back before its hello, so it offers updates at once.
  const s = await setup(t, { record: 'spare' });
  await until('online, updates offered', () => s.mm.canLink('mx'));
  assert.equal(readJson<{ service: string }>(path.join(s.root, 'root.json'))?.service, 'com.fffactory.linktest');
  assert.equal(s.mm.linkProblem('mx'), undefined);
  // Gone again while it runs: an unload over the link puts it back at the call and goes ahead.
  fs.rmSync(path.join(s.root, 'root.json'));
  s.d.selfUpdate.deps.launch = async () => 'a stand-in job';
  fs.mkdirSync(path.join(updateFiles(s.appDir).src, 'scripts', 'worker'), { recursive: true });
  fs.writeFileSync(path.join(updateFiles(s.appDir).src, 'scripts', 'worker', 'linkJob.ts'), '');
  await s.mm.linkControl('mx', 'uninstall');
  assert.ok(fs.existsSync(path.join(s.root, 'root.json')), 'put back at the call');

  // Neither the file nor a copy (a daemon from before w1918 kept none): connected, no offer, and a reason instead of ssh.
  const n = await setup(t, { record: 'none' });
  await until('online, its hello read', () => n.mm.hasHello('mx'));
  assert.equal(n.mm.canLink('mx'), false);
  assert.match(n.mm.linkProblem('mx') ?? '', /mx's daemon .*is connected but did not offer updates over its link .*root\.json was missing or unreadable .*Not sent over ssh/);
});

test('w4672: a daemon that connected with its Dev Drive detached offers updates over its link once the drive is back, without a reconnect', async (t) => {
  const s = await setup(t, { record: 'spare', detached: true });
  await until('online, its hello read', () => s.mm.hasHello('mx'));
  assert.equal(s.mm.canLink('mx'), false, 'root.json could not be put back at the hello: no offer');
  assert.match(s.mm.linkProblem('mx') ?? '', /did not offer updates over its link/);
  const link = (s.d as unknown as { ws: unknown }).ws;
  // Still detached: the daemon's look finds nothing to offer, and sends nothing.
  assert.equal(s.d.offerSelfUpdate(), false);
  // The host guard reattaches the drive: its root is a folder again, empty (root.json is put back from the spare copy).
  fs.rmSync(s.root);
  fs.mkdirSync(s.root);
  await until('the offer arrives on the same link', () => s.mm.canLink('mx'), 5000);
  assert.equal(readJson<{ service: string }>(path.join(s.root, 'root.json'))?.service, 'com.fffactory.linktest', 'put back from its spare copy');
  assert.equal(s.mm.linkProblem('mx'), undefined);
  assert.equal((s.d as unknown as { ws: unknown }).ws, link, 'the same link: no reconnect was needed');
  // Offered once: a later look sends nothing more.
  assert.equal(s.d.offerSelfUpdate(), false);
});

test("w4674: a daemon whose install joined with -NoSsh says so in its hello: the record keeps it, and no ssh is planned once it is offline", async (t) => {
  const s = await setup(t, { outside: [{ kind: 'task', name: 'FF Factory daemon' }] });
  await until('online, its hello read', () => s.mm.hasHello('mx'));
  assert.equal(s.mm.list().find((m) => m.id === 'mx')?.noSsh, true);
  assert.ok(s.mm.canLink('mx'), 'connected: updated over its link');
  assert.match(s.mm.sshProblem('mx') ?? '', /its daemon is connected and updates over its link now/, 'and never over ssh');
  s.d.shutdown();
  await until('offline', () => !s.mm.isOnline('mx'), 5000);
  assert.match(s.mm.sshProblem('mx') ?? '', /mx has no portal ssh: .*-NoSsh .*an update over its daemon's link .*its daemon is offline now.*a local worker in one of mx's sandboxes .*Not sent over ssh/);

  const ssh = await setup(t, { outside: [{ kind: 'authorized-key', name: '/home/x/.ssh/authorized_keys' }] });
  await until('online, its hello read', () => ssh.mm.hasHello('mx'));
  assert.equal(ssh.mm.list().find((m) => m.id === 'mx')?.noSsh, undefined);
  assert.equal(ssh.mm.noSshProblem('mx'), undefined);
});

test('w1918: keepRootJson keeps the spare copy fresh and puts root.json back only for a root on its Dev Drive, never throwing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-rootjson-'));
  try {
    const root = path.join(tmp, 'V', 'ffw');
    const appDir = path.join(tmp, 'D', 'daemon');
    fs.mkdirSync(root, { recursive: true });
    const onDrive = { machineId: 'mx', service: 'FFFactoryDaemon', devDrive: { rootOnDrive: true, host: path.join(tmp, 'D') } };
    // A hand-written file with a byte order mark: read, and copied without it.
    fs.writeFileSync(path.join(root, 'root.json'), String.fromCharCode(0xfeff) + JSON.stringify(onDrive));
    assert.equal(keepRootJson(root, appDir), undefined);
    assert.equal(fs.readFileSync(rootBackupOf(appDir), 'utf8'), JSON.stringify(onDrive));
    // Unreadable, then missing with its folder: put back each time, the folder made again.
    fs.writeFileSync(path.join(root, 'root.json'), '{ half');
    assert.match(keepRootJson(root, appDir) ?? '', /root\.json was unreadable: put back from .*root-backup\.json/);
    assert.equal(readJson<{ service: string }>(path.join(root, 'root.json'))?.service, 'FFFactoryDaemon');
    fs.rmSync(root, { recursive: true });
    assert.match(keepRootJson(root, appDir) ?? '', /was missing: put back/);
    assert.ok(fs.existsSync(path.join(root, 'root.json')));
    // The drive not attached (its root cannot be made): nothing, and no throw.
    const blocked = path.join(tmp, 'file-not-drive');
    fs.writeFileSync(blocked, '');
    assert.equal(keepRootJson(path.join(blocked, 'ffw'), appDir), undefined);
    // A root that is not on its Dev Drive keeps a copy but is never put back (its daemon folder goes with it).
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'root.json'), JSON.stringify({ machineId: 'mx', service: 'svc' }));
    const plainApp = path.join(plain, 'daemon');
    keepRootJson(plain, plainApp);
    fs.rmSync(path.join(plain, 'root.json'));
    assert.equal(keepRootJson(plain, plainApp), undefined);
    assert.equal(fs.existsSync(path.join(plain, 'root.json')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

test('w1641: an answer after its call timed out is told with what the call was, never dropped', async () => {
  let t = 1_000_000;
  const p = new PendingCalls<true>(() => t);
  const hold = setTimeout(() => undefined, 1000);
  const q = p.wait('a5c3a1cb-0000', 'beast', 20, 'the tools over its link');
  t += 300_000;
  await assert.rejects(q, /beast did not answer the tools over its link/);
  clearTimeout(hold);
  assert.equal(p.settle('a5c3a1cb-0000', new Error('beast refused it: git fetch failed')), false, 'nobody waits for it any more');
  const late = p.late('a5c3a1cb-0000');
  assert.equal(late?.what, 'the tools over its link');
  assert.equal(
    unwaitedAnswer('beast', 'a5c3a1cb-0000', late, 'refused it: git fetch failed', 1_000_000 + 400_000),
    'machine beast: a late answer to the tools over its link (call a5c3a1cb): it refused it: git fetch failed, 6 min 40 s after it was sent; the portal had given up after 5 min 0 s',
  );
  assert.equal(p.late('a5c3a1cb-0000'), undefined, 'told once');
  assert.match(unwaitedAnswer('beast', 'ffffffff-1', undefined, 'took it'), /an answer to call ffffffff that nothing waits for \(it took it\)/);
});

/** A bundle server for the download tests: `plan(n, range)` says what its n-th request (from 1) does. */
async function bundleServer(t: { after: (f: () => void) => void }, body: Buffer, plan: (n: number, range: string | undefined) => 'stall' | 'cut' | 'whole' | 'serve' | number) {
  const seen: (string | undefined)[] = [];
  const held: http.ServerResponse[] = [];
  const s = http.createServer((req, res) => {
    const range = req.headers.range;
    seen.push(range);
    const what = plan(seen.length, range);
    if (typeof what === 'number') return void res.writeHead(what).end();
    const from = what !== 'whole' && range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0;
    res.writeHead(from ? 206 : 200, { 'content-length': String(body.length - from), ...(from ? { 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` } : {}) });
    if (what === 'stall' || what === 'cut') {
      // Half of what is left, then nothing more (the w1641 stall), or the connection cut.
      res.write(body.subarray(from, from + Math.floor((body.length - from) / 2)));
      if (what === 'cut') setTimeout(() => res.socket?.destroy(), 20);
      else held.push(res);
      return;
    }
    res.end(body.subarray(from));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  t.after(() => {
    for (const r of held) r.socket?.destroy();
    s.close();
  });
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
}

test('w1641: a bundle download that stalls or is cut resumes where it stopped, each retry logged with its reason', async (t) => {
  const body = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7) % 251));
  const b = { sha256: createHash('sha256').update(body).digest('hex'), size: body.length };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffdl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // beast's case: the stream stops sending and stays open. Before w1641 nothing noticed for 300 s (undici's body timeout).
  const stall = await bundleServer(t, body, (n) => (n === 1 ? 'stall' : 'serve'));
  const lines: string[] = [];
  const file = await downloadBundle(stall.url, 'tok', b, path.join(dir, 'a'), fetch, { stallMs: 300, log: (l) => lines.push(l) });
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), b.sha256);
  assert.deepEqual(stall.seen, [undefined, `bytes=${body.length / 2}-`], 'the second request resumes from the bytes the first got');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /stalled \(no byte in 0 s\) at 100000 of 200000 bytes; attempt 2 of 6 resumes from there/);

  // A cut connection says why (the cause undici keeps behind "terminated").
  const cut = await bundleServer(t, body, (n) => (n === 1 ? 'cut' : 'serve'));
  lines.length = 0;
  await downloadBundle(cut.url, 'tok', b, path.join(dir, 'b'), fetch, { stallMs: 5000, log: (l) => lines.push(l) });
  assert.match(lines[0] ?? '', /broke: .+ at 100000 of 200000 bytes/);

  // A portal that answers a resume with the whole file: taken from 0, still the bundle it said.
  const whole = await bundleServer(t, body, (n) => (n === 1 ? 'stall' : 'whole'));
  const f2 = await downloadBundle(whole.url, 'tok', b, path.join(dir, 'c'), fetch, { stallMs: 300 });
  assert.equal(createHash('sha256').update(fs.readFileSync(f2)).digest('hex'), b.sha256);

  // Every try stalls: it gives up with the reason, the part file gone.
  const never = await bundleServer(t, body, () => 'stall');
  await assert.rejects(downloadBundle(never.url, 'tok', b, path.join(dir, 'd'), fetch, { stallMs: 200, attempts: 2 }), /the bundle's download stalled \(no byte in 0 s\) at \d+ of 200000 bytes, after 2 attempt\(s\)/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'd')), []);

  // A refusal is not retried.
  const refused = await bundleServer(t, body, () => 404);
  await assert.rejects(downloadBundle(refused.url, 'tok', b, path.join(dir, 'e'), fetch, { stallMs: 300 }), /the portal answered 404/);
  assert.equal(refused.seen.length, 1);

  assert.equal(fetchError(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' }) })), 'terminated (UND_ERR_BODY_TIMEOUT: Body Timeout Error)');
});

test('w5938: a stall check that comes late (the daemon blocked its own loop) is not a stall; the bytes that came meanwhile are read', async (t) => {
  const body = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 11) % 251));
  const b = { sha256: createHash('sha256').update(body).digest('hex'), size: body.length };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffdl-'));
  // The portal in a thread of its own, so it sends while this thread's loop is blocked: 1000 bytes, the rest 200 ms later.
  const portal = new Worker(
    `const http = require('node:http'); const { parentPort } = require('node:worker_threads');
     const body = Buffer.from(Array.from({ length: 200000 }, (_, i) => (i * 11) % 251));
     const s = http.createServer((req, res) => {
       parentPort.postMessage({ range: req.headers.range ?? null });
       res.writeHead(200, { 'content-length': String(body.length) });
       res.write(body.subarray(0, 1000));
       setTimeout(() => res.end(body.subarray(1000)), 200);
     });
     s.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: s.address().port }));`,
    { eval: true },
  );
  t.after(async () => {
    await portal.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const seen: (string | null)[] = [];
  const port = await new Promise<number>((r) => portal.on('message', (m: { port?: number; range?: string | null }) => (m.port ? r(m.port) : seen.push(m.range ?? null))));
  // beast, 2026-11-26: LoopWatch logged the loop blocked 40-72 s; here 1.2 s, outside a timer (a sync call in an I/O or
  // immediate callback), so the next turn of the loop runs the due stall check before it reads the socket.
  const run = async (sub: string, lateMs: number) => {
    const lines: string[] = [];
    setTimeout(() => setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200)), 100);
    const file = await downloadBundle(`http://127.0.0.1:${port}`, 'tok', b, path.join(dir, sub), fetch, { stallMs: 300, lateMs, log: (l) => lines.push(l) });
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), b.sha256);
    return lines;
  };
  // Before w5938 (no check of lateness): the late check is taken for a stall and the download starts again.
  const before = await run('before', 1e9);
  assert.match(before.join('\n'), /stalled \(no byte in 0 s\) at 1000 of 200000 bytes; attempt 2 of 6/);
  assert.deepEqual(seen.splice(0), [null, 'bytes=1000-']);
  const lines = await run('after', 200);
  assert.deepEqual(seen, [null], 'one request: no retry');
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /the bundle's stall check came \d+ s late \(this daemon's event loop was blocked\), at 1000 of 200000 bytes: not a stall/);
});

test('w5938: jobToEnd ends a job only past its limit: staged and never taken, its process gone or another program, or hung; never a live one writing its log', () => {
  const at = Date.parse('2026-11-26T06:11:26Z');
  const job = { id: '977d56f7-1030-442b-bcad-bd6ac62ab798', form: 'update', root: 'r', appDir: 'a', service: 's', createdAt: new Date(at).toISOString(), phase: 'running', pid: process.pid } as UpdateJob;
  const mine = { command: 'node /x/src/scripts/worker/linkJob.ts --job /x/update/job.json' };
  const staged = { ...job, phase: 'staged', pid: undefined } as UpdateJob;
  const gone = { ...job, pid: 2 ** 30 };
  const lim = JOB_LIMIT.inFlightMs;
  const watched = { watchedMs: JOB_LIMIT.watchMs };
  // Inside its limit: never touched, whatever its process does.
  assert.equal(jobToEnd(job, at + 15.5 * 60_000, { ...mine, logAt: at }), undefined, "beast's 15.5 min job (977d56f7) is within its limit");
  assert.equal(jobToEnd(staged, at + JOB_LIMIT.stagedMs - 60_000, watched), undefined, 'a job staged 9 min ago is left for its process');
  assert.equal(jobToEnd(gone, at + lim - 60_000, watched), undefined, 'a job whose process went 44 min in is left (a restart at logon takes it over)');
  assert.equal(jobToEnd({ ...job, phase: 'done' }, at + 10 * lim), undefined, 'a job that ended is not ended again');
  // Past it, alive and progressing, or not known to be the job's: never ended, and the hold says which.
  assert.equal(jobToEnd(job, at + 3 * 60 * 60_000, { ...mine, logAt: at + 3 * 60 * 60_000 - 60_000 })?.hold, 'its process is alive and still writing its log', 'a live job process that wrote its log a minute ago is left, 3 h in');
  assert.match(jobToEnd(job, at + 10 * lim, { logAt: at })?.hold ?? '', /its command line could not be read, so it is not known to be the job's/, 'a live pid whose command line cannot be read is never ended');
  // Staged or gone, but not yet watched so for 5 min (after a reboot its logon task goes first): held.
  assert.match(jobToEnd(gone, at + 8 * 60 * 60_000, { watchedMs: 0 })?.hold ?? '', /watched it so for 0 of the 5 min it waits for the job's own task/);
  assert.match(jobToEnd(staged, at + JOB_LIMIT.stagedMs + 60_000, { watchedMs: JOB_LIMIT.watchMs - 60_000 })?.hold ?? '', /watched it so for 4 of the 5 min/);
  // Past it and stuck: ended, with why.
  assert.deepEqual(jobToEnd(staged, at + JOB_LIMIT.stagedMs + 60_000, watched), { reason: 'job 977d56f7 (update) was staged 11 min ago and its process never took it (limit 10 min)', kill: false });
  assert.deepEqual(jobToEnd(gone, at + lim + 60_000, watched), { reason: `job 977d56f7 (update) has run 46 min (limit 45 min) and its process (pid ${2 ** 30}) is gone without a result`, kill: false });
  assert.deepEqual(jobToEnd(job, at + lim + 60_000, { command: 'firefox', logAt: at + lim, ...watched }), { reason: `job 977d56f7 (update) has run 46 min (limit 45 min) and its pid ${process.pid} is now another program's, so its process is gone without a result`, kill: false });
  assert.deepEqual(jobToEnd(job, at + lim + 60_000, { ...mine, logAt: at + lim + 60_000 - JOB_LIMIT.quietMs - 60_000 }), { reason: `job 977d56f7 (update) has run 46 min (limit 45 min) and its process (pid ${process.pid}) is hung: its log unwritten for 16 min while this daemon watched (limit 15 min)`, kill: true });
  assert.equal(jobToEnd(job, at + lim + 60_000, { ...mine, logAt: at + lim + 60_000 - JOB_LIMIT.quietMs + 60_000 })?.kill, false, 'quiet 14 min: not yet hung');
  assert.match(inFlightRefusal(job, at + lim + 60_000), /^an update job of this machine is still running: job 977d56f7 .* past its 45 min limit, but its process is alive and still writing its log, so it is not ended \(w5938\)$/);
  assert.match(inFlightRefusal(job, at + lim + 60_000, 'its process did not end when stopped'), /, but its process did not end when stopped, so it is not ended \(w5938\)$/);
  assert.equal(inFlightRefusal(job, at + 3 * 60_000), 'an update job of this machine is still running (job 977d56f7, update, 3 min since it was made)');
});

/** A daemon's updater over a job fixture (w5938) on a clock of its own: its logs, what it sent, and the files. */
function overdueFixture(
  t: { after: (fn: () => unknown) => void },
  job: Partial<UpdateJob>,
  o: { command?: (pid: number) => Promise<string | undefined>; stop?: (pid: number, sig: NodeJS.Signals) => void } = {},
) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffjob-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  const f = updateFiles(appDir);
  const full = { id: '977d56f7-1030-442b-bcad-bd6ac62ab798', form: 'update', root: 'r', appDir, service: 's', createdAt: new Date().toISOString(), phase: 'running', commit: 'c'.repeat(40), before: 'b'.repeat(40), ...job } as UpdateJob;
  writeJson(f.job, full);
  const logs: string[] = [];
  const sent: FromDaemon[] = [];
  const stopped: string[] = [];
  const clock = { now: Date.now() };
  const u = new SelfUpdater({
    appDir,
    portalUrl: () => 'http://x',
    token: 't',
    send: (m) => (sent.push(m), true),
    exit: () => undefined,
    log: (...a) => logs.push(a.join(' ')),
    remove: async () => undefined,
    now: () => clock.now,
    command: o.command ?? (async () => undefined),
    kill: (pid, sig) => void (stopped.push(`${pid} ${sig}`), (o.stop ?? ((p, s) => process.kill(p, s)))(pid, sig)),
    stopWaitMs: 500,
  });
  /** The daemon looks every 10 s for `ms`, awake: its clock moves with each look. */
  const watch = async (ms: number) => {
    for (const end = clock.now + ms; clock.now < end; ) {
      clock.now += 10_000;
      await u.tick();
    }
  };
  return { u, f, logs, sent, stopped, clock, watch, job: full };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const writeLog = (file: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${new Date().toISOString()} FF Factory update job 977d56f7-1030-442b-bcad-bd6ac62ab798: update to ff-factory cccccccccccc (w1596).\nRunning the installer...\n`);
};
/** A stand-in job process: its command line names linkJob.ts, and it runs until it is stopped. */
const standIn = (t: { after: (fn: () => unknown) => void }) => {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'linkJob.ts'], { stdio: 'ignore' });
  t.after(() => void p.kill('SIGKILL'));
  return p;
};
const linuxCommand = (pid: number) => processCommand(pid);

test('w5938: a staged job past 10 min is ended by the tick once watched 5 min: failed with the reason in update-job.log and the daemon log, reported, and taken off the machine', async (t) => {
  const x = overdueFixture(t, { phase: 'staged', createdAt: ago(JOB_LIMIT.stagedMs + 60_000) });
  await x.u.tick();
  assert.equal(readJson<UpdateJob>(x.f.job)?.phase, 'staged', 'first sight (a reboot, a restart): its own task may still take it');
  assert.ok(x.logs.some((l) => /WARNING job 977d56f7 .* staged and never taken .*; this daemon has watched it so for 0 of the 5 min/.test(l)), x.logs.join('\n'));
  await x.watch(JOB_LIMIT.watchMs);
  const job = readJson<UpdateJob>(x.f.job)!;
  assert.equal(job.phase, 'done');
  const r = readJson<LinkUpdateReport>(x.f.result)!;
  assert.deepEqual([r.id, r.ok, r.exit, r.form, r.before], [x.job.id, false, 1, 'update', 'b'.repeat(40)]);
  assert.match(r.note!, /^the daemon ended the job: job 977d56f7 \(update\) was staged 16 min ago and its process never took it \(limit 10 min\); this machine takes updates again, its daemon runs on \(w5938\)$/);
  const log = fs.readFileSync(x.f.log, 'utf8');
  assert.match(log, /FF Factory update job 977d56f7-1030-442b-bcad-bd6ac62ab798: update to ff-factory cccccccccccc \(never started by its process\)\.\n.* job 977d56f7-1030-442b-bcad-bd6ac62ab798: FAILED \(the daemon ended the job: .*\)\.\n$/);
  assert.match(r.log, /FAILED \(the daemon ended the job/, "the report carries the job's own log section");
  assert.ok(x.logs.some((l) => l.startsWith('update over the link: FAILED the daemon ended the job: job 977d56f7')), x.logs.join('\n'));
  assert.ok(x.sent.some((m) => m.type === 'self_update_report' && m.report.id === x.job.id && !m.report.ok), 'the failed result went to the portal');
  await x.u.tick();
  assert.equal(readJson<UpdateJob>(x.f.job)?.removed, true, 'its task or LaunchAgent is removed, as after any job');
  assert.equal(x.logs.filter((l) => /FAILED the daemon ended/.test(l)).length, 1, 'ended once');
});

test('w5938: a job whose process is gone is ended only past 45 min and once watched 5 min awake; after a long reboot its logon task goes first', async (t) => {
  const young = overdueFixture(t, { pid: 2 ** 30, createdAt: ago(JOB_LIMIT.inFlightMs - 10 * 60_000) });
  await young.watch(JOB_LIMIT.watchMs);
  assert.equal(readJson<UpdateJob>(young.f.job)?.phase, 'running');
  assert.equal(fs.existsSync(young.f.result), false, 'inside its limit: never touched');

  // w5983's review, probe B: a job made 8 h ago whose process a reboot cut off. The daemon's first look leaves it.
  const old = overdueFixture(t, { pid: 2 ** 30, createdAt: ago(8 * 60 * 60_000) });
  await old.u.tick();
  assert.equal(readJson<UpdateJob>(old.f.job)?.phase, 'running', "first look: the job's logon task may resume it");
  // Its logon task takes it over meanwhile (a new pid, its own): the daemon's watch starts again and nothing is ended.
  const resumed = standIn(t);
  await until('the stand-in up', () => alive(resumed.pid));
  writeJson(old.f.job, { ...old.job, pid: resumed.pid });
  writeLog(old.f.log);
  await old.watch(JOB_LIMIT.watchMs + 60_000);
  assert.equal(readJson<UpdateJob>(old.f.job)?.pid, resumed.pid);
  assert.equal(fs.existsSync(old.f.result), false, 'the resumed job is left to finish');

  // Nobody takes it: ended after 5 min awake, and a sleep in between starts the watch again.
  const dead = overdueFixture(t, { pid: 2 ** 30, createdAt: ago(8 * 60 * 60_000) });
  await dead.watch(JOB_LIMIT.watchMs - 60_000);
  dead.clock.now += 20 * 60_000; // asleep 20 min
  await dead.watch(JOB_LIMIT.watchMs - 60_000);
  assert.equal(readJson<UpdateJob>(dead.f.job)?.phase, 'running', 'two 4 min watches with a sleep between are not 5 min');
  await dead.watch(2 * 60_000);
  assert.equal(readJson<UpdateJob>(dead.f.job)?.phase, 'done');
  assert.match(readJson<LinkUpdateReport>(dead.f.result)!.note!, /has run \d+ min \(limit 45 min\) and its process \(pid \d+\) is gone without a result/);
  assert.deepEqual(dead.stopped, [], 'nothing to stop');
});

test('w5938: a live job process past 45 min is stopped and ended only when its log has been quiet 15 min while the daemon watched; one still writing, or frozen by sleep, is never touched', async (t) => {
  const busy = standIn(t);
  await until('the stand-in up', () => alive(busy.pid));
  const live = overdueFixture(t, { pid: busy.pid, createdAt: ago(3 * 60 * 60_000) }, { command: linuxCommand });
  writeLog(live.f.log);
  for (let i = 0; i < 4; i++) {
    await live.watch(10 * 60_000);
    writeLog(live.f.log);
  }
  assert.equal(readJson<UpdateJob>(live.f.job)?.phase, 'running', 'a live job writing its log is left, 3 h in');
  assert.ok(alive(busy.pid), 'and its process runs on');
  assert.deepEqual(live.stopped, []);
  assert.equal(live.logs.filter((l) => /WARNING job 977d56f7 .* past its 45 min limit; its process is alive and still writing its log/.test(l)).length, 1, live.logs.join('\n'));

  // w5983's review, probe A: a job 40 min in wrote its log, then the computer slept 20 min. Waking is no quiet log.
  const sleeper = standIn(t);
  await until('the stand-in up', () => alive(sleeper.pid));
  const slept = overdueFixture(t, { pid: sleeper.pid, createdAt: ago(40 * 60_000) }, { command: linuxCommand });
  writeLog(slept.f.log);
  await slept.u.tick();
  slept.clock.now += 20 * 60_000;
  await slept.u.tick();
  await slept.watch(JOB_LIMIT.quietMs - 60_000);
  assert.deepEqual(slept.stopped, [], 'quiet 14 min while watched, after a 20 min sleep: not hung');
  assert.equal(readJson<UpdateJob>(slept.f.job)?.phase, 'running');
  // A long blocked loop between two looks counts the same way: not watched.
  slept.clock.now += 10 * 60_000;
  await slept.watch(JOB_LIMIT.quietMs - 60_000);
  assert.deepEqual(slept.stopped, [], 'a 10 min gap is not watched quiet time');
  // Quiet 16 min while the daemon watched: hung, stopped with TERM, ended.
  await slept.watch(2 * 60_000);
  assert.deepEqual(slept.stopped, [`${sleeper.pid} SIGTERM`]);
  assert.equal(alive(sleeper.pid), false, 'the hung process was stopped');
  assert.equal(readJson<UpdateJob>(slept.f.job)?.phase, 'done');
  assert.match(readJson<LinkUpdateReport>(slept.f.result)!.note!, /is hung: its log unwritten for 1[56] min while this daemon watched \(limit 15 min\)/);

  // A live pid that is not a job process (its pid taken by another program) is never stopped: the job alone is ended.
  const other = overdueFixture(t, { pid: process.pid, createdAt: ago(JOB_LIMIT.inFlightMs + 60_000) }, { command: async () => 'node --test server/machineLink.test.ts' });
  await other.watch(JOB_LIMIT.watchMs + 10_000);
  assert.deepEqual(other.stopped, []);
  assert.match(readJson<LinkUpdateReport>(other.f.result)!.note!, /is now another program's/);
});

test('w5938: a hung job that ignores TERM gets KILL; one that will not end is left in flight and the refusal says so; one its process takes back meanwhile is not ended', async (t) => {
  const quietFor = async (x: ReturnType<typeof overdueFixture>) => {
    writeLog(x.f.log);
    await x.watch(JOB_LIMIT.quietMs + 60_000);
  };
  // TERM ignored, KILL ends it.
  const deaf = standIn(t);
  await until('the stand-in up', () => alive(deaf.pid));
  const a = overdueFixture(t, { pid: deaf.pid, createdAt: ago(JOB_LIMIT.inFlightMs + 60_000) }, { command: linuxCommand, stop: (p, s) => void (s === 'SIGKILL' && process.kill(p, s)) });
  await quietFor(a);
  assert.deepEqual(a.stopped, [`${deaf.pid} SIGTERM`, `${deaf.pid} SIGKILL`]);
  assert.equal(readJson<UpdateJob>(a.f.job)?.phase, 'done');

  // Neither ends it: left in flight, warned once, and a new update's refusal says why.
  const stubborn = standIn(t);
  await until('the stand-in up', () => alive(stubborn.pid));
  const b = overdueFixture(t, { pid: stubborn.pid, createdAt: ago(JOB_LIMIT.inFlightMs + 60_000) }, { command: linuxCommand, stop: () => undefined });
  await quietFor(b);
  await b.watch(60_000);
  assert.equal(readJson<UpdateJob>(b.f.job)?.phase, 'running');
  assert.equal(fs.existsSync(b.f.result), false);
  assert.equal(b.logs.filter((l) => /WARNING .* is hung: .*; its process did not end when stopped, so the job is left in flight/.test(l)).length, 1, b.logs.join('\n'));
  assert.deepEqual(b.stopped, [`${stubborn.pid} SIGTERM`, `${stubborn.pid} SIGKILL`], 'tried once, not at every tick');
  await b.watch(5 * 60_000);
  assert.equal(b.stopped.length, 4, 'and again 5 min later');

  // Its process takes the job back while it is being stopped (a new pid): the job as it was seen is not ended.
  const old = standIn(t);
  await until('the stand-in up', () => alive(old.pid));
  const fresh = standIn(t);
  await until('the stand-in up', () => alive(fresh.pid));
  const c = overdueFixture(t, { pid: old.pid, createdAt: ago(JOB_LIMIT.inFlightMs + 60_000) }, {
    command: linuxCommand,
    stop: (p, s) => {
      writeJson(c.f.job, { ...c.job, pid: fresh.pid });
      process.kill(p, s);
    },
  });
  writeLog(c.f.log);
  c.clock.now += 10_000;
  await c.u.tick();
  for (let i = 0; i < 96 && c.stopped.length === 0; i++) {
    c.clock.now += 10_000;
    await c.u.tick();
  }
  assert.deepEqual(c.stopped, [`${old.pid} SIGTERM`]);
  assert.equal(readJson<UpdateJob>(c.f.job)?.pid, fresh.pid);
  assert.equal(fs.existsSync(c.f.result), false, 'the re-check leaves the job its process took back');
});

test('w5938: an update sent while an overdue job holds the lock is taken: the stale job is ended first and the new one starts', async (t) => {
  const s = await setup(t);
  await until('online, its hello read', () => s.mm.canLink('mx'));
  s.d.selfUpdate.deps.launch = finishing(s, {});
  s.d.selfUpdate.deps.remove = async () => undefined;
  const f = updateFiles(s.appDir);
  writeJson(f.job, { id: '977d56f7-1030-442b-bcad-bd6ac62ab798', form: 'tools', root: s.root, appDir: s.appDir, service: 'com.fffactory.linktest', createdAt: ago(JOB_LIMIT.stagedMs + 60_000), phase: 'staged' } satisfies UpdateJob);
  // The daemon has watched it 5 min: a clock of its own, a look every 10 s.
  const clock = { now: Date.now() };
  s.d.selfUpdate.deps.now = () => clock.now;
  for (let i = 0; i < JOB_LIMIT.watchMs / 10_000; i++) {
    clock.now += 10_000;
    await s.d.selfUpdate.endOverdue();
  }
  assert.equal(readJson<UpdateJob>(f.job)?.phase, 'staged', 'not yet ended');
  clock.now += 10_000;
  const r = await s.mm.linkUpdate('mx');
  assert.equal(r.ok, true, 'not refused for the stale job');
  assert.notEqual(readJson<UpdateJob>(f.job)?.id, '977d56f7-1030-442b-bcad-bd6ac62ab798');
  assert.match(fs.readFileSync(f.log, 'utf8'), /job 977d56f7-1030-442b-bcad-bd6ac62ab798: FAILED \(the daemon ended the job: job 977d56f7 \(tools\) was staged \d+ min ago/);
});

test('w1641: an answer the link could not carry goes again when it is back; one sent just before a drop too; the portal ignores a repeat', async () => {
  let t = 1_000_000;
  let up = false;
  const sent: { id: string; ok: boolean }[] = [];
  const logs: string[] = [];
  const u = new SelfUpdater({
    appDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ffans-')),
    portalUrl: () => 'http://127.0.0.1:1',
    token: 'tok',
    send: (m) => {
      if (!up) return false;
      sent.push(m as { id: string; ok: boolean });
      return true;
    },
    exit: () => undefined,
    log: (...a) => logs.push(a.join(' ')),
    now: () => t,
  });
  const call = (id: string) => u.onSelfUpdate({ type: 'self_update', id, form: 'update', commit: 'a'.repeat(40), bundle: { sha256: 'b'.repeat(64), size: 1 } });
  // The 450f7d53c rollout: the answer came while the portal VM's Tailscale restarted and the link was down.
  await call('e158273f-0001');
  assert.equal(sent.length, 0, 'not sent: the link is down');
  assert.match(logs.join('\n'), /link down: the answer to call e158273f goes when it is back/);
  up = true;
  t += 30_000;
  u.relink();
  assert.deepEqual(sent.map((m) => [m.id, m.ok]), [['e158273f-0001', false]], 'sent once the link is back');
  u.relink();
  assert.equal(sent.length, 1, 'once');
  t += 120_000;

  // One sent into a socket that was already dead (noticed only after 45 s of silence): the drop within a minute sends it again.
  await call('8681c507-0002');
  assert.equal(sent.length, 2);
  t += 50_000;
  u.linkDown();
  u.relink();
  assert.deepEqual(sent.map((m) => m.id), ['e158273f-0001', '8681c507-0002', '8681c507-0002']);
  // A drop long after it was sent: the link had it.
  t += 120_000;
  u.linkDown();
  u.relink();
  assert.equal(sent.length, 3);
  // An answer kept longer than ANSWERS.keepMs is let go.
  up = false;
  await call('0cf7e814-0003');
  t += ANSWERS.keepMs + 1;
  up = true;
  u.relink();
  assert.equal(sent.length, 3, 'too old to matter');

  const p = new PendingCalls<true>(() => t);
  const q = p.wait('8681c507-0002', 'beast', 5000, 'the tools over its link');
  assert.equal(p.settle('8681c507-0002', true), true);
  await q;
  assert.equal(p.settle('8681c507-0002', true), false);
  assert.equal(p.repeat('8681c507-0002'), true, 'a repeat: nothing to log');
  assert.equal(p.repeat('ffffffff-9'), false);
});

test('w1641: the portal logs each update bundle it serves, finished or cut', () => {
  assert.equal(bundleServedLine('beast', { start: 0, sent: 18_595_141, size: 18_595_141, ms: 7_400, finished: true }), 'machine beast: the update bundle went out in 7.4 s (2454 KB/s)');
  assert.equal(
    bundleServedLine('beast', { start: 6_962_988, sent: 1_000_000, size: 18_595_141, ms: 312_000, finished: false }),
    'machine beast: the update bundle was cut from byte 6962988 after 7962988 of 18595141 bytes in 312.0 s (3 KB/s)',
  );
});

test('w5546: the read fence goes to warn, on and off again over the link with nobody at the machine; an older daemon is never sent it; an unknown action is refused, never taken as an unload', async (t) => {
  const s = await setup(t);
  await until('online', () => s.mm.canLink('mx'));
  const marker = path.join(s.appDir, 'read-fence');
  assert.equal(fs.existsSync(marker), false, 'off by default: no mode file');
  await s.mm.controlDaemon('mx', 'read-fence-warn');
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'warn');
  assert.equal(s.exits.length, 0, 'no restart');
  if (process.platform === 'linux') {
    // Lockout re-review B4 of #1193: on is refused on Linux, with the reason, and the mode stays as it was.
    await assert.rejects(s.mm.controlDaemon('mx', 'read-fence-on'), /refused on Linux/);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'warn');
  } else {
    await s.mm.controlDaemon('mx', 'read-fence-on');
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'on');
  }
  await s.mm.controlDaemon('mx', 'read-fence-off');
  assert.equal(fs.existsSync(marker), false, 'off: the file is gone, so runs start with no read rules');
  // A daemon from before the switch said no readFenceSwitch in its hello: its onControl took any other action as an unload.
  (s.mm as unknown as { hellos: Map<string, { readFenceSwitch?: boolean }> }).hellos.get('mx')!.readFenceSwitch = undefined;
  await assert.rejects(s.mm.linkControl('mx', 'read-fence-off'), /no read fence switch|before the read fence switch/);
  assert.equal(s.launched.length, 0, 'nothing was unloaded');
  // This daemon's own answer to an action it does not know.
  const sent: { ok: boolean; error?: string }[] = [];
  const u = new SelfUpdater({ appDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ffrf-')), portalUrl: () => 'http://127.0.0.1:1', token: 'tok', send: (m) => (sent.push(m as { ok: boolean }), true), exit: () => assert.fail('no exit'), log: () => undefined });
  await u.onControl({ type: 'daemon_control', id: 'c1', action: 'something-new' as 'restart' });
  await u.onControl({ type: 'daemon_control', id: 'c2', action: 'read-fence-off' });
  assert.deepEqual(sent.map((m) => m.ok), [false, false]);
  assert.match(sent[0].error ?? '', /unknown action something-new/);
  assert.match(sent[1].error ?? '', /no read fence switch/);
});
