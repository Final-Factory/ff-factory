// The dry run (server/dryRun.ts, change 17; w499): with FFSB_DRY_RUN=1 nothing that acts outside the portal can fire.
// Each part is checked where it would act, with the switch read as the server reads it (process.env), and one test
// boots the real server on a copied-looking data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import type http from 'node:http';
import webpush from 'web-push';
import WebSocket from 'ws';
import { DRY_RUN_WHY, defuseConfig, dryRun, dryRunStartRefusal } from './dryRun.ts';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Waker } from './wake.ts';
import { Timers, type TimerHost } from './timers.ts';
import { StandingAgents, type SessionLike, type SessionPort } from './standing.ts';
import { Notifier } from './notify.ts';
import { ProviderManager } from './providers.ts';
import { IntakeManager } from './intake.ts';
import { LedgerSweep } from './ledgerSweep.ts';
import { MaxManager } from './max.ts';
import { UsageTracker } from './usage.ts';
import { setAppConfig } from './appConfig.ts';
import type { Config } from './config.ts';
import type { Machine, SessionInfo } from '../shared/types.ts';

/** The switch as the server reads it, on for the test and put back after. */
function on(t: { after: (fn: () => void) => void }) {
  const before = process.env.FFSB_DRY_RUN;
  process.env.FFSB_DRY_RUN = '1';
  t.after(() => {
    if (before === undefined) delete process.env.FFSB_DRY_RUN;
    else process.env.FFSB_DRY_RUN = before;
  });
  return { off: () => (process.env.FFSB_DRY_RUN = '0'), on: () => (process.env.FFSB_DRY_RUN = '1') };
}

function tmp(t: { after: (fn: () => void) => void }, prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** A socket that records what an upgrade handler answers. */
function fakeSocket() {
  const said: string[] = [];
  let destroyed = false;
  const socket = {
    write: (s: string) => (said.push(s), true),
    end: (s?: string) => (s && said.push(s), socket),
    destroy: () => (destroyed = true),
  } as unknown as Duplex;
  return { socket, said, destroyed: () => destroyed };
}
const upgradeReq = (authorization: string) => ({ headers: { authorization }, url: '/x' }) as unknown as http.IncomingMessage;

test('dry run: read from FFSB_DRY_RUN=1 only; only a person writing to an orchestrator starts a process; claudeEnv is ignored', (t) => {
  assert.equal(dryRun({}), false);
  assert.equal(dryRun({ FFSB_DRY_RUN: '0' }), false);
  assert.equal(dryRun({ FFSB_DRY_RUN: 'true' }), false, 'exactly "1", as the unit file writes it');
  assert.equal(dryRun({ FFSB_DRY_RUN: '1' }), true);
  on(t);
  assert.equal(dryRunStartRefusal({ kind: 'orchestrator' }, 'human'), undefined, 'a person writing to an orchestrator (the resume check)');
  assert.match(dryRunStartRefusal({ kind: 'orchestrator' }, 'system') ?? '', /only a person's message starts an orchestrator/, 'a wake, a timer, a restart note');
  assert.match(dryRunStartRefusal({ kind: 'orchestrator' }, 'orchestrator') ?? '', /dry run/, 'another agent');
  for (const kind of ['worker', 'standing'] as const) assert.equal(dryRunStartRefusal({ kind }, 'human'), DRY_RUN_WHY, kind);
  assert.equal(dryRunStartRefusal({ kind: 'worker', machineId: 'm5' }, 'human'), DRY_RUN_WHY, 'an agent on a machine');

  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'not-a-real-token-a' }, userClaudeEnv: { ben: { CLAUDE_CODE_OAUTH_TOKEN: 'not-a-real-token-b' } } } as Pick<Config, 'claudeEnv' | 'userClaudeEnv'>;
  assert.deepEqual(defuseConfig(cfg), ['claudeEnv', 'userClaudeEnv']);
  assert.equal(cfg.claudeEnv, undefined);
  assert.equal(cfg.userClaudeEnv, undefined);
  assert.deepEqual(defuseConfig(cfg), [], 'nothing left to drop');
});

test('dry run: no worker, standing agent or machine agent starts, nor an orchestrator the server itself writes to; queued messages stay the real portal\'s', (t) => {
  on(t);
  const dir = tmp(t, 'ffsb-dry-sessions-');
  fs.writeFileSync(path.join(dir, 'send-queue.json'), JSON.stringify({ queue: [{ uuid: 'q1', id: 'w1', text: 'from the real portal', from: 'human', at: new Date().toISOString(), why: 'all slots busy' }] }));
  const queueBefore = fs.readFileSync(path.join(dir, 'send-queue.json'), 'utf8');
  const store = new Store(dir);
  t.after(() => store.flush());
  const sessions = new SessionManager({ dataDir: dir } as Config, store);
  const worker = sessions.create({ id: 'w1', kind: 'worker', title: 'w', permissionMode: 'bypassPermissions', options: () => assert.fail('no worker process may start') });
  const standing = sessions.create({ id: 'st1', kind: 'standing', title: 's', permissionMode: 'bypassPermissions', options: () => assert.fail('no standing process may start') });
  const orch = sessions.create({ id: 'o1', kind: 'orchestrator', title: 'o', permissionMode: 'bypassPermissions', options: () => assert.fail('no orchestrator process in a unit test') });

  assert.equal(sessions.drain(), 0, 'the copied queue was not loaded');
  for (const id of [worker.info.id, standing.info.id]) {
    assert.throws(() => sessions.send(id, 'go', 'human'), /not started: this portal is a dry run/, id);
    assert.throws(() => sessions.send(id, 'go', 'system', undefined, { bypassGate: true }), /dry run/, `${id}: the host guard's bypass does not reach past it`);
  }
  assert.throws(() => sessions.send(orch.info.id, '[wake_me] Time is up', 'system'), /only a person's message starts an orchestrator/);
  assert.throws(() => sessions.send(orch.info.id, 'from the dispatcher', 'orchestrator'), /dry run/);
  assert.equal(sessions.checkStart(orch.info.id, false, 'human'), orch, 'a person may start it');
  // The last word, for any path that reaches the process without SessionManager.send.
  assert.throws(() => orch.send('a timer fired', 'system'), /not started: .*dry run/);
  assert.throws(() => worker.send('go', 'human'), /not started: .*dry run/);
  // A worker's first prompt waits instead of failing, and never goes.
  sessions.send(worker.info.id, 'the brief', 'orchestrator', undefined, { hold: true });
  assert.equal(sessions.drain(), 0);
  assert.equal(worker.live, false);
  assert.equal(fs.readFileSync(path.join(dir, 'send-queue.json'), 'utf8'), queueBefore, 'the copied queue file is left as it was');
});

test('dry run: wakes and the heartbeat never fire; the copied wakes.json is left as it was', (t) => {
  const sw = on(t);
  const dir = tmp(t, 'ffsb-dry-wake-');
  const store = new Store(dir);
  t.after(() => store.flush());
  const sent: string[] = [];
  const sessions = {
    sessions: new Map([['o1', {}]]),
    get: () => ({}),
    send: (id: string, text: string) => (sent.push(`${id}: ${text}`), 'u'),
  } as unknown as SessionManager;
  const file = path.join(dir, 'wakes.json');
  sw.off();
  const real = new Waker(sessions, store, file);
  real.schedule('o1', 5, 'from the real portal');
  sw.on();
  const before = fs.readFileSync(file, 'utf8');
  const w = new Waker(sessions, store, file);
  w.now = () => Date.now() + 3_600_000; // long past due
  assert.equal(w.restore(), 0, 'none armed');
  assert.deepEqual(w.all(), []);
  assert.throws(() => w.schedule('o1', 1, 'x'), /wake_me: refused, this portal is a dry run/);
  store.sessions.set('wk', { id: 'wk', kind: 'worker', status: 'running', title: 'busy' } as SessionInfo);
  store.sessions.set('o1', { id: 'o1', kind: 'orchestrator', status: 'idle', title: 'o' } as SessionInfo);
  w.heartbeat('o1', 5, () => 'busy');
  w.heartbeat('o1', 5, () => 'busy');
  assert.deepEqual(sent, []);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  (real as unknown as { timers: Map<string, { timer: NodeJS.Timeout }> }).timers.forEach((x) => clearTimeout(x.timer));
});

test('dry run: timers load to be shown but never come due, deliver or get made', (t) => {
  const sw = on(t);
  const dir = tmp(t, 'ffsb-dry-timers-');
  const file = path.join(dir, 'timers.json');
  const sent: string[] = [];
  const host: TimerHost = { exists: () => true, busy: () => false, deliver: (id, text) => void sent.push(`${id}: ${text}`) };
  sw.off();
  const real = new Timers(host, file);
  const T0 = Date.parse('2026-10-05T12:00:00Z');
  real.now = () => T0;
  real.create('o1', { title: 'FFBox desync scan', note: 'scan', schedule: { every_minutes: 60 } }, 'lothsahn');
  sw.on();
  const before = fs.readFileSync(file, 'utf8');
  const ts = new Timers(host, file);
  ts.now = () => T0 + 5 * 3_600_000; // five firings missed
  assert.equal(ts.start(), 1, 'loaded');
  t.after(() => ts.stop());
  ts.tick();
  ts.turnEnded('o1');
  assert.deepEqual(sent, []);
  assert.throws(() => ts.create('o1', { title: 'x', note: 'y', schedule: { every_minutes: 60 } }, 'ben'), /a new timer: refused, this portal is a dry run/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('dry run: a standing agent that is due does not run, and Run now is refused', (t) => {
  on(t);
  const dir = tmp(t, 'ffsb-dry-standing-');
  const cfg = { dataDir: path.join(dir, 'data'), sandboxRoot: path.join(dir, 'sb'), standingRoot: path.join(dir, 'sb', '_agents'), protectedPaths: [], repo: { url: 'x', basePath: path.join(dir, 'sb', '_base') }, limits: { maxSessions: 6 }, models: ['opus'], defaultModel: 'opus', worker: { permissionMode: 'bypassPermissions', effort: 'high' } } as unknown as Config;
  const store = new Store(cfg.dataDir);
  t.after(() => store.flush());
  const infos = new Map<string, SessionInfo>();
  const sent: string[] = [];
  const port: SessionPort = {
    events: new EventEmitter(),
    create: (o) => {
      const info = { id: `s${infos.size + 1}`, kind: o.kind, title: o.title, status: 'stopped', permissionMode: o.permissionMode, standingId: o.standingId, createdAt: '', lastActivityAt: '', turns: 0, costUsd: 0, pendingPermissions: [] } as SessionInfo;
      infos.set(info.id, info);
      return { info, live: false, stop() {} } as SessionLike;
    },
    get: (id) => ({ info: infos.get(id)!, live: false, stop() {} }),
    send: (id) => (sent.push(id), 'u'),
    remove: () => undefined,
  };
  const clock = { now: new Date('2026-10-05T03:00:00') };
  // w510: standing agents run on machines; m1 is an online one whose sessions are the port's.
  const m1 = { id: 'm1', platform: 'linux', appDir: '/home/u/.fff', repoPath: '/home/u/game', maxSessions: 6, status: 'ready', purpose: 'x', sessionIds: [] } as unknown as Machine;
  const machines = { list: () => [m1], get: (id: string) => (id === 'm1' ? m1 : undefined), isOnline: () => true, liveCount: () => 0, createSession: (_m: string, o: Parameters<SessionPort['create']>[0]) => port.create(o) };
  const st = new StandingAgents({ cfg, store, sessions: port, notify: () => undefined, machines: machines as never, now: () => clock.now });
  const a = st.create({ name: 'Triager', charter: 'Triage.', trigger: { kind: 'interval', minutes: 30 }, tools: ['delegate'], machineId: 'm1' });
  const due = a.nextRunAt;
  clock.now = new Date(clock.now.getTime() + 5 * 3_600_000);
  st.tick();
  const after = st.require(a.id);
  assert.equal(after.nextRunAt, due, 'not advanced');
  assert.equal(after.pending, undefined);
  assert.deepEqual(after.runs, []);
  assert.deepEqual(sent, []);
  assert.throws(() => st.runNow(a.id), /a run of Triager: refused, this portal is a dry run/);
});

test('dry run: no push reaches a phone, the test push included', async (t) => {
  on(t);
  const dir = tmp(t, 'ffsb-dry-push-');
  const store = new Store(dir);
  t.after(() => store.flush());
  const n = new Notifier(dir, store, new SessionManager({} as Config, store));
  const real = webpush.sendNotification;
  let calls = 0;
  (webpush as { sendNotification: unknown }).sendNotification = async () => void calls++;
  t.after(() => ((webpush as { sendNotification: unknown }).sendNotification = real));
  n.subscribe('lothsahn', { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }, {}, 'phone');
  n.host('Unity on m5 restarted', 'x');
  assert.equal(await n.test('lothsahn'), 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 0);
});

test('dry run: the FFBox connector and every machine daemon are turned away, and no machine is deployed, controlled, removed or relocated', async (t) => {
  on(t);
  const dir = tmp(t, 'ffsb-dry-links-');
  const cfg = { dataDir: dir, limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' }, providers: { ffbox: { enabled: true } } } as unknown as Config;
  const store = new Store(dir);
  t.after(() => store.flush());
  const pm = new ProviderManager(cfg);
  t.after(() => pm.close());
  const p = fakeSocket();
  assert.equal(pm.upgrade(upgradeReq('Bearer ffpv1_x'), p.socket, Buffer.alloc(0), '127.0.0.1'), false);
  assert.match(p.said.join(''), /^HTTP\/1\.1 503 /);

  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  mm.deployer = async () => assert.fail('no deploy');
  const { token } = mm.register({ id: 'mx', host: 'mx', purpose: 'unused', status: 'ready', repoPath: dir, home: dir, portalUrl: 'http://127.0.0.1:1' });
  const m = fakeSocket();
  assert.equal(mm.upgrade(upgradeReq(`Bearer ${token}`), m.socket, Buffer.alloc(0), '127.0.0.1'), false, 'a valid token too');
  assert.match(m.said.join(''), /^HTTP\/1\.1 503 /);
  assert.equal(m.destroyed(), true);
  assert.equal(mm.isOnline('mx'), false);

  assert.throws(() => mm.deployMachine({ id: 'mx' }), /deploying mx: refused, this portal is a dry run/);
  assert.throws(() => mm.deployMachine({ id: 'newbox', host: 'newbox', portalUrl: 'https://x' }), /dry run/);
  assert.throws(() => mm.convertMachine('mx', 'ssh', { sshHost: 'mx', redeploy: true }), /redeploying mx: refused/);
  await assert.rejects(mm.controlDaemon('mx', 'restart', true), /a daemon restart on mx: refused/);
  await assert.rejects(mm.removeMachine('mx'), /removing mx .*refused/);
  await assert.rejects(mm.relocate('mx', 'https://fff.example.ts.net'), /relocating mx: refused/);
  let probed = 0;
  assert.deepEqual(await mm.watchOffline(Date.now() + 3_600_000, async () => (probed++, true)), []);
  assert.equal(probed, 0, 'no ssh probe either');
  assert.deepEqual(mm.checkOutdated(Date.now() + 3_600_000), []);
  assert.ok(mm.list().some((x) => x.id === 'mx'), 'still there');
});

test('dry run: intake, the ledger sweep, Max and the usage poll start no timer and reach nothing', (t) => {
  on(t);
  const dir = tmp(t, 'ffsb-dry-polls-');
  const cfg = { dataDir: dir, intake: { discord: { enabled: true }, release: { enabled: true } }, max: { ffboxConfigDir: path.join(dir, 'ffbox'), eventsFile: path.join(dir, 'events.jsonl') } } as unknown as Config;
  const timersOf = (x: object) => (x as { timers: unknown[] }).timers;
  const intake = new IntakeManager({ cfg, store: {} as never, identity: {} as never, orchestrators: {} as never });
  assert.equal(intake.start(), intake);
  assert.deepEqual(timersOf(intake), []);
  const sweep = new LedgerSweep({ cfg, store: {} as never, orchestrators: {} as never, resume: () => assert.fail('no resume'), limitsClear: () => true, intakeMerged: async () => 0 } as never);
  assert.equal(sweep.start(), sweep);
  assert.deepEqual(timersOf(sweep), []);
  const max = new MaxManager(cfg, { session: () => undefined, standingName: () => undefined });
  max.fetch = async () => assert.fail('no Discord call');
  assert.equal(max.start(), max);
  assert.deepEqual(timersOf(max), []);
  assert.equal((max as unknown as { tail?: unknown }).tail, undefined);
  const usage = new UsageTracker(cfg, () => undefined);
  usage.start();
  assert.equal((usage as unknown as { started: boolean }).started, false);
});

test('dry run: set_app_config takes no Claude token, and leaves the file alone', (t) => {
  on(t);
  const dir = tmp(t, 'ffsb-dry-config-');
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ownerName: 'Ben' }, null, 2));
  const cfg = { ownerName: 'Ben' } as Config;
  for (const key of ['claudeEnv.CLAUDE_CODE_OAUTH_TOKEN', 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN'] as const) {
    assert.throws(() => setAppConfig(file, cfg, key, 'not-a-real-token', { user: 'ben' }), new RegExp(`${key.replace(/\./g, '\\.')}: refused, this portal is a dry run`));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ ownerName: 'Ben' }, null, 2));
  assert.equal(cfg.claudeEnv, undefined);
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test('dry run: the real server says so in its health and its log, turns away daemons and FFBox, and resumes, wakes and delivers nothing', { timeout: 120_000 }, async (t) => {
  const base = tmp(t, 'ffsb-dry-boot-');
  const data = path.join(base, 'data');
  const repo = path.join(base, 'base');
  fs.mkdirSync(data);
  fs.mkdirSync(path.join(base, 'sandboxes'));
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  const port = await freePort();
  // A made-up token-shaped value: the log must never show it.
  const fakeToken = `sk-ant-oat01-${'DryRunNotARealToken'.repeat(5)}`;
  fs.writeFileSync(
    path.join(base, 'config.json'),
    JSON.stringify({
      port,
      host: '127.0.0.1',
      trustProxy: false,
      dataDir: data,
      sandboxRoot: path.join(base, 'sandboxes'),
      repo: { url: repo, basePath: repo },
      defaultBase: 'develop',
      unity: { editorPath: path.join(base, 'no-unity', 'Unity.exe'), watchdog: { stallMinutes: 0, runningPollSeconds: 0, autoDismiss: false } },
      voice: { enabled: false, autoInstall: false, tts: false },
      hostGuard: { pollSeconds: 0 },
      orchestrator: { notifyOnWorkerEvents: false },
      claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken },
      providers: { ffbox: { enabled: true } },
    }),
  );
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const worker = { id: 'w1', kind: 'worker', title: 'a worker', status: 'idle', permissionMode: 'bypassPermissions', createdAt: at, lastActivityAt: at, turns: 1, costUsd: 0, pendingPermissions: [] };
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ sandboxes: [], sessions: [worker], settings: { heartbeatMinutes: null } }, null, 2));
  // What the real portal left: a wake past due, a queued message, a resume note, an inbox note for the orchestrator.
  const files: Record<string, string> = {
    'wakes.json': JSON.stringify({ w1: { at: Date.now() - 600_000, note: 'from the real portal' } }),
    'send-queue.json': JSON.stringify({ queue: [{ uuid: 'q1', id: 'w1', text: 'queued there', from: 'human', at, why: 'busy' }] }),
    'resume.json': JSON.stringify({ reason: 'update', sessions: [] }),
    'orchestrator-inbox/republish.txt': 'a note for the orchestrator',
  };
  fs.mkdirSync(path.join(data, 'orchestrator-inbox'));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(data, f), text);

  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = { ...process.env, FFSB_DRY_RUN: '1', FFSB_CONFIG: path.join(base, 'config.json'), HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'DISCORD_TOKEN']) delete env[k];
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'index.ts')], { cwd: path.join(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  const until = async (what: RegExp, ms: number) => {
    const end = Date.now() + ms;
    while (!what.test(log)) {
      if (child.exitCode !== null) assert.fail(`the server exited (${child.exitCode}) before ${what}:\n${log}`);
      if (Date.now() > end) assert.fail(`no ${what} within ${ms} ms:\n${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  await until(new RegExp(`on http://127\\.0\\.0\\.1:${port}`), 60_000);
  assert.match(log, /!!!!!!!! DRY RUN \(FFSB_DRY_RUN=1\)\. Nothing here acts outside/);
  assert.match(log, /Ignored: config claudeEnv\./);

  const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { ok: boolean; dryRun?: boolean };
  assert.equal(health.ok, true);
  assert.equal(health.dryRun, true);

  const refused = (p: string) =>
    new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`, { headers: { authorization: 'Bearer ffm_mx_' + 'a'.repeat(43) } });
      ws.on('unexpected-response', (_req, res) => (resolve(res.statusCode), ws.terminate()));
      ws.on('open', () => (resolve(undefined), ws.close()));
      ws.on('error', () => resolve(-1));
    });
  assert.equal(await refused('/machine'), 503, 'no daemon link');
  assert.equal(await refused('/provider'), 503, 'no FFBox connector');

  // The resume runs 2 s after the start, the inbox every 5 s, the queue every 30 s: give the first two their turn.
  await until(/dry run: nothing resumed after the start/, 20_000);
  await new Promise((r) => setTimeout(r, 6000));
  for (const [f, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(data, f), 'utf8'), text, `${f} is as the real portal left it`);
  assert.equal(fs.existsSync(path.join(data, 'orchestrator-inbox', 'republish.sent')), false);
  assert.doesNotMatch(log, /DryRunNotARealToken/, 'the token is never printed');
  assert.doesNotMatch(log, /\[wake_me\]|queued a message|sessions: stopped/);

  fs.writeFileSync(path.join(data, 'restart.request'), '');
  assert.equal(await exited, 0);
  t.diagnostic(log.split('\n').filter((l) => /DRY RUN|dry run|refused/.test(l)).join('\n'));
});
