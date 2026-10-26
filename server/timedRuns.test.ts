import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { AttachmentStore, machineAttachment, machineUploadHttp } from './attachments.ts';
import { agentCap, poolSettingsOf } from './machines.ts';
import { TimedRuns, variantProblem } from './timedRuns.ts';
import { GROUP_MAX_BYTES, legArgs, legOrder, perfSummaryOf, PIECE_MAX_BYTES, planPieces, SMALL_FILE_BYTES, timedArgsProblem, TIMED_DEFAULTS, type TimedRunOrder } from '../shared/timedRun.ts';
import { foreignTicket, releaseTicket, takeTicket, TimedRunner, writeTarGz } from '../machine/timedRunner.ts';
import { readBenchLock } from '../machine/benchLock.ts';
import { insideRoots, scanBuild, timedRunFromMachine } from '../machine/timedRunPack.ts';
import type { Machine } from '../shared/types.ts';

/**
 * w1946: a play-only timing machine. The worker's daemon sends the pieces of its builds the portal lacks, the portal hands
 * the run as data to the play-only computer, whose daemon plays the fixed legs under its own exclusive ticket and sends the
 * logs back to the worker. lothsahn: "I don't want a unilateral way into machines... just build scoped commands for the
 * functionality needed".
 */

const tmp = (t: { after(fn: () => void): void }, tag = 'w1946-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('pieces: a big file is cut into pieces of its own, small files are grouped, every byte once', () => {
  const big = PIECE_MAX_BYTES * 2 + 5;
  const files = [
    { path: 'b/small1', size: 10 },
    { path: 'a/huge.resS', size: big },
    { path: 'b/small2', size: GROUP_MAX_BYTES - 5 },
    { path: 'c/mid', size: SMALL_FILE_BYTES },
  ];
  const pieces = planPieces(files);
  // huge: 3 pieces; small1 + small2 do not fit one group (10 + 16 MB - 5 > 16 MB): 2 groups; mid (8 MB) alone.
  assert.equal(pieces.length, 3 + 2 + 1);
  for (const p of pieces) assert.ok(p.size <= PIECE_MAX_BYTES);
  const covered = new Map<string, number>();
  for (const p of pieces) for (const part of p.parts) covered.set(part.path, (covered.get(part.path) ?? 0) + part.length);
  for (const f of files) assert.equal(covered.get(f.path), f.size, f.path);
});

test('a variant takes -ff switches only, never the run\'s own or a command', () => {
  assert.equal(timedArgsProblem(undefined), undefined);
  assert.equal(timedArgsProblem(['-ffNoHangWatchdog']), undefined);
  assert.equal(timedArgsProblem(['-ffShadowQuality', '2']), undefined);
  assert.match(timedArgsProblem(['-ffSoloLoad', 'x']) ?? '', /set by the run itself/);
  assert.match(timedArgsProblem(['-ffAutomationSave', 'other']) ?? '', /set by the run itself/);
  assert.match(timedArgsProblem(['-ffBench', 'x']) ?? '', /set by the run itself/);
  assert.equal(timedArgsProblem(['-ffBenchStartTile', '-1,-228']), undefined);
  assert.equal(timedArgsProblem(['-ffX', '-2.5']), undefined);
  assert.match(timedArgsProblem(['-ffX', '-1,-2,-3,-4,-5']) ?? '', /not a -ff switch/);
  assert.match(timedArgsProblem(['-logFile', 'C:/x']) ?? '', /not a -ff switch/);
  assert.match(timedArgsProblem(['cmd.exe']) ?? '', /not a -ff switch/);
  assert.match(timedArgsProblem(['-ffX', 'a b']) ?? '', /not a -ff switch/);
  assert.match(timedArgsProblem(['-ffX', '&calc']) ?? '', /not a -ff switch/);
});

test('the legs are probe_ab_win.sh\'s: its arguments, and the order flipped on even rounds', () => {
  const a = legArgs(TIMED_DEFAULTS, { name: 'fix', args: ['-ffX'] }, 2, 'ffa-timed-tr_1', 'V:/out/player.log');
  const at = (k: string) => a[a.indexOf(k) + 1];
  assert.equal(at('-ffAutomationRole'), 'solo');
  assert.equal(at('-ffAutomationSave'), 'ffa-timed-tr_1');
  assert.equal(at('-ffAutomationPostReadyCommand'), 'ffauto:wait|25;ffauto:perf.sample|20|20;ffauto:wait|30');
  assert.equal(at('-ffAutomationAutoQuit'), 'true');
  assert.equal(at('-logFile'), 'V:/out/player.log');
  assert.equal(a[a.length - 1], '-ffX');
  assert.deepEqual(
    legOrder(['base', 'fix'], 2).map((l) => `${l.variant}${l.round}`),
    ['base1', 'fix1', 'fix2', 'base2'],
  );
  assert.deepEqual(perfSummaryOf('x\n[Audit] PerfSummary hb=320 frames=1200 fps=60.1 ups=16.0 frameAvgMs=16.640 frameP95Ms=18.2 frameMaxMs=40.1\n'), { frameAvgMs: 16.64, frameP95Ms: 18.2, frameMaxMs: 40.1, fps: 60.1, ups: 16, hb: 320 });
});

test('a play-only computer has no pool and runs no agent, whatever its installer gave it', () => {
  const m = { sandboxRoot: 'V:/ffw/sandboxes', maxSandboxes: 1, playOnly: 'lothsahn, 2026-10-23: "play-only timing machine"' };
  assert.equal(poolSettingsOf(m), null);
  assert.equal(agentCap(m), 0);
  assert.notEqual(poolSettingsOf({ ...m, playOnly: '' }), null);
});

test('the portal refuses a variant whose files leave the build or are not wholly sent', () => {
  const ok = { name: 'a', args: [], files: [{ path: 'finalfactory.exe', size: 3 }], pieces: [{ sha256: 'a'.repeat(64), size: 3, parts: [{ path: 'finalfactory.exe', offset: 0, length: 3 }] }] };
  assert.equal(variantProblem(ok), undefined);
  assert.match(variantProblem({ ...ok, files: [...ok.files, { path: '../evil.dll', size: 1 }] }) ?? '', /bad file entry/);
  assert.match(variantProblem({ ...ok, files: [...ok.files, { path: 'C:/x', size: 1 }] }) ?? '', /bad file entry/);
  assert.match(variantProblem({ ...ok, files: [...ok.files, { path: 'missing', size: 1 }] }) ?? '', /not wholly in its pieces/);
  assert.match(variantProblem({ ...ok, pieces: [{ ...ok.pieces[0], parts: [{ path: 'finalfactory.exe', offset: 2, length: 3 }] }] }) ?? '', /past its end/);
  assert.match(variantProblem({ ...ok, files: [{ path: 'game.exe', size: 3 }], pieces: [{ ...ok.pieces[0], parts: [{ path: 'game.exe', offset: 0, length: 3 }] }] }) ?? '', /no finalfactory.exe/);
});

test('the ticket is written in the bench queue\'s own format, so the machine\'s bench row shows it held, and goes', (t) => {
  const root = tmp(t);
  const name = takeTicket(root, { what: 'timed run tr_0123456789: w1891', session: 's1', requests: ['w1891'], maxMin: 20 });
  assert.equal(name, 't00000001');
  const held = readBenchLock(root);
  assert.match(held?.owner ?? '', /timed run tr_0123456789: w1891 \[t00000001\]/);
  // Our own ticket is not "someone else's"; a live bench_queue.py holder is.
  assert.equal(foreignTicket(root), undefined);
  releaseTicket(root, name);
  assert.equal(readBenchLock(root), undefined);
  assert.equal(takeTicket(root, { what: 'b', session: 's1', requests: [], maxMin: 5 }), 't00000001');
});

test('w2116: a path that does not exist yet is inside a root reached through a link (a Windows short name, RUNNER~1)', (t) => {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, 'real'));
  fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link'), 'junction');
  assert.ok(insideRoots(path.join(d, 'link', 'a', 'b'), [path.join(d, 'link')]));
  assert.ok(insideRoots(path.join(d, 'link', 'a', 'b'), [path.join(d, 'real')]));
  assert.ok(!insideRoots(path.join(d, 'link', '..', 'elsewhere', 'b'), [path.join(d, 'real')]));
});

test('a build is read only from the sandbox, the session temp folder or the worker install', (t) => {
  const d = tmp(t);
  assert.ok(insideRoots(path.join(d, 'a', 'b'), [d]));
  assert.ok(!insideRoots(path.join(d, '..', 'elsewhere'), [d]));
  fs.mkdirSync(path.join(d, 'p', 'finalfactory_Data'), { recursive: true });
  assert.throws(() => scanBuild(path.join(d, 'p')), /no Windows player here/);
  fs.writeFileSync(path.join(d, 'p', 'finalfactory.exe'), 'x');
  fs.mkdirSync(path.join(d, 'p', 'finalfactory_BurstDebugInformation_DoNotShip'));
  fs.writeFileSync(path.join(d, 'p', 'finalfactory_BurstDebugInformation_DoNotShip', 'big.txt'), 'debug');
  fs.writeFileSync(path.join(d, 'p', 'finalfactory_Data', 'lib.pdb'), 'pdb');
  fs.writeFileSync(path.join(d, 'p', 'finalfactory_Data', 'data.assets'), 'assets');
  assert.deepEqual(scanBuild(path.join(d, 'p')).map((f) => f.path).sort(), ['finalfactory.exe', 'finalfactory_Data/data.assets']);
});

/** A fake player: writes a PerfSummary into its -logFile, and whether the bench lock was held while it ran. */
const FAKE_PLAYER = `
const fs = require('fs');
const a = process.argv.slice(2);
const log = a[a.indexOf('-logFile') + 1];
const held = fs.existsSync(process.env.FAKE_LOCK + '/owner') ? fs.readFileSync(process.env.FAKE_LOCK + '/owner', 'utf8').trim() : 'none';
const exe = fs.readFileSync(require('path').join(process.cwd(), 'finalfactory.exe'), 'utf8');
const ms = exe.includes('fast') ? 15.5 : 16.5;
fs.writeFileSync(log, 'lock: ' + held + '\\nsave: ' + a[a.indexOf('-ffAutomationSave') + 1] + '\\n[Audit] PerfSummary hb=320 frames=1200 fps=60 ups=16 frameAvgMs=' + ms + ' frameP95Ms=18 frameMaxMs=30\\n');
`;

test('end to end: two builds made on one computer are timed on a play-only one under its ticket, the logs come back', async (t) => {
  const d = tmp(t, 'w1946e2e-');
  const store = new AttachmentStore(path.join(d, 'portal'));
  // The portal's two machine routes, as server/index.ts serves them: a token per machine.
  const tokens: Record<string, string> = { 'tok-beast': 'beast', 'tok-desk': 'desk' };
  const server = http.createServer((req, res) => {
    const machine = tokens[String(req.headers.authorization ?? '').replace(/^Bearer /, '')];
    const url = new URL(req.url ?? '/', 'http://x');
    const up = /^\/machine\/attachments\/uploads\/([0-9a-f]+)$/.exec(url.pathname);
    if (up) return void machineUploadHttp(store, machine, req, res, up[1], Number(url.searchParams.get('offset') ?? 0));
    const get = /^\/machine\/attachments\/(att_[a-z0-9]{12})$/.exec(url.pathname);
    if (get) {
      const r = machineAttachment(store, machine, get[1]);
      if ('error' in r) return void res.writeHead(r.status).end();
      res.writeHead(200, { 'content-length': r.record.size });
      return void fs.createReadStream(r.file).pipe(res);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const portalUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // The play-only computer's daemon: its runner, with a fake player.
  const deskRoot = path.join(d, 'desk');
  const fake = path.join(d, 'fake-player.cjs');
  fs.writeFileSync(fake, FAKE_PLAYER);
  const runs = { runner: undefined as unknown as TimedRunner };
  const delivered: { session: string; text: string; files: { id: string; name: string }[] }[] = [];
  let posted = 0;
  const tr = new TimedRuns({
    dataDir: path.join(d, 'portal'),
    store,
    machines: () => [{ id: 'desk', playOnly: 'test', platform: 'win32' } as unknown as Machine, { id: 'beast', platform: 'win32' } as unknown as Machine],
    isOnline: () => true,
    offers: (id) => id === 'desk',
    post: (id, msg) => {
      assert.equal(id, 'desk');
      posted++;
      const m = msg as { type: string; order: TimedRunOrder; id: string; uploadId: string; chunkBytes?: number };
      if (m.type === 'timed_run') runs.runner.enqueue(m.order);
      if (m.type === 'timed_run_upload') runs.runner.uploadReady(m.id, m.uploadId, m.chunkBytes);
      return true;
    },
    deliver: async (session, text, files) => void delivered.push({ session, text, files }),
  });
  runs.runner = new TimedRunner({
    root: deskRoot,
    portalUrl,
    token: 'tok-desk',
    send: (m) => setImmediate(() => tr.onReport('desk', m)),
    log: () => {},
    personBusy: () => undefined,
    savesDir: path.join(d, 'saves'),
    pollMs: 5,
    spawnPlayer: (_exe, args, cwd) => spawn(process.execPath, [fake, ...args], { cwd, stdio: 'ignore', env: { ...process.env, FAKE_LOCK: path.join(deskRoot, 'tmp', 'bench.lock') } }),
  });

  // The worker's computer: two builds that share their big asset file, and a save.
  const sandbox = path.join(d, 'beast', 'slot1');
  const mk = (name: string, exe: string) => {
    const p = path.join(sandbox, 'builds', name);
    fs.mkdirSync(path.join(p, 'finalfactory_Data', 'Managed'), { recursive: true });
    fs.writeFileSync(path.join(p, 'finalfactory.exe'), exe);
    fs.writeFileSync(path.join(p, 'finalfactory_Data', 'Managed', 'FFCore.dll'), `code ${name}`);
    fs.writeFileSync(path.join(p, 'finalfactory_Data', 'resources.assets.resS'), Buffer.alloc(SMALL_FILE_BYTES + 1000, 7));
    return p;
  };
  mk('base', 'slow player');
  mk('fix', 'fast player');
  fs.writeFileSync(path.join(sandbox, 'bench.zip'), 'PK save bytes');
  const worker = { session: 'sess-1', requests: ['w1891'], what: 'w1891 RoundRobin (worker sess-1)' };
  const plans: { uploads: unknown[] }[] = [];
  const rpc = async (a: Record<string, unknown>) => {
    if (a.phase === 'plan') {
      const out = tr.plan('beast', worker, a);
      plans.push(JSON.parse(out));
      return out;
    }
    return tr.go('sess-1', a);
  };
  const call = (builds: unknown[]) => timedRunFromMachine({ portalUrl, token: 'tok-beast', roots: [sandbox], cwd: sandbox, tempDir: path.join(d, 'beast', 'tmp'), args: { builds, save: 'bench.zip', rounds: 2, sample_s: 5, settle_s: 5 }, rpc });
  const done = (n: number) =>
    new Promise<void>((resolve, reject) => {
      const until = Date.now() + 60_000;
      const look = () => (delivered.length >= n ? resolve() : Date.now() > until ? reject(new Error('no result in 60 s')) : setTimeout(look, 50));
      look();
    });

  const answer = await call([
    { name: 'base', path: 'builds/base' },
    { name: 'fix', path: 'builds/fix' },
  ]);
  assert.match(answer, /Timed run tr_[0-9a-f]{10} handed to desk: base vs fix, 4 legs/);
  // exe, FFCore.dll (small: one group per build), the shared .resS once, the save: 2 groups + 1 + 1.
  assert.equal(plans[0].uploads.length, 4);
  await done(1);
  const first = delivered[0];
  assert.equal(first.session, 'sess-1');
  assert.match(first.text, /done: 4 of 4 legs with numbers/);
  assert.match(first.text, /base: n=2 frameAvgMs 16\.500/);
  assert.match(first.text, /fix: n=2 frameAvgMs 15\.500/);
  assert.equal(first.files.length, 1);
  // The logs: probe_ab_win.sh's layout, each leg played while this run held the machine's ticket, on its own save copy.
  const rec = store.get(first.files[0].id)!;
  const tar = gunzipSync(fs.readFileSync(store.pathOf(rec)));
  const entries: { name: string; body: string }[] = [];
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8);
    entries.push({ name, body: tar.subarray(off + 512, off + 512 + size).toString('utf8') });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  const id = /tr_[0-9a-f]{10}/.exec(first.text)![0];
  const log = entries.find((e) => e.name === `${id}/fix/round2/player.log`);
  assert.ok(log, entries.map((e) => e.name).join(', '));
  assert.match(log.body, new RegExp(`lock: timed run ${id}: w1891 RoundRobin \\(worker sess-1\\) \\[t\\d{8}\\]`));
  assert.match(log.body, new RegExp(`save: ffa-timed-${id}`));
  assert.ok(entries.some((e) => e.name === `${id}/summary.tsv`) && entries.some((e) => e.name === `${id}/base/round1/cpu.csv`));
  // Afterwards: the ticket and the save copy are gone.
  assert.equal(readBenchLock(deskRoot), undefined);
  assert.deepEqual(fs.readdirSync(path.join(d, 'saves')), []);
  assert.equal(tr.get(id)?.state, 'done');

  // A second run after a change to one build sends only that build's changed group: the rest is on the portal.
  fs.writeFileSync(path.join(sandbox, 'builds', 'fix', 'finalfactory_Data', 'Managed', 'FFCore.dll'), 'code fix v2');
  await call([
    { name: 'base', path: 'builds/base' },
    { name: 'fix', path: 'builds/fix' },
  ]);
  assert.equal(plans[1].uploads.length, 1);
  await done(2);
  assert.match(delivered[1].text, /done: 4 of 4 legs/);
  assert.ok(posted >= 4);

  // A build outside the worker's folders is refused before anything is read.
  await assert.rejects(call([{ name: 'x', path: path.join(d, 'desk') }]), /outside your sandbox/);
});

test('the results archive is a plain ustar .tar.gz', async (t) => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, 'a.txt'), 'hello');
  await writeTarGz([{ name: 'run/a.txt', file: path.join(d, 'a.txt') }], path.join(d, 'r.tar.gz'));
  const tar = gunzipSync(fs.readFileSync(path.join(d, 'r.tar.gz')));
  assert.equal(tar.subarray(0, 9).toString(), 'run/a.txt');
  assert.equal(tar.subarray(257, 262).toString(), 'ustar');
  // The header checksum: the sum of its bytes with the checksum field as spaces.
  const h = Buffer.from(tar.subarray(0, 512));
  const stored = parseInt(h.subarray(148, 154).toString(), 8);
  h.fill(0x20, 148, 156);
  assert.equal(stored, h.reduce((s, b) => s + b, 0));
  assert.equal(tar.subarray(512, 517).toString(), 'hello');
  assert.equal(tar.length % 512, 0);
});
