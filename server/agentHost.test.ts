// w605: agents outlive their daemon. A real daemon process runs a worker in a real agent host process (the scripted
// fake agent instead of Claude Code); the daemon is killed mid-turn and a new one takes the host back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager, type SessionHandle } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { LineTail, hostAlive, hostFiles, pidAlive } from '../machine/agentHost.ts';
import type { Config } from './config.ts';
import type { MachineSandbox } from '../shared/types.ts';

const DAEMON = path.join(import.meta.dirname, '..', 'machine', 'daemon.ts');

const until = async (what: string, cond: () => boolean, ms = 20_000, more = () => '') => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${more() ? `\n${more()}` : ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** A throwaway portal with one machine, and a way to start that machine's daemon as a process of its own. */
async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-hosts-'));
  const cfg = { dataDir: path.join(tmp, 'data'), limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' } } as unknown as Config;
  fs.mkdirSync(cfg.dataDir);
  const store = new Store(cfg.dataDir);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  const agentDir = path.join(tmp, 'sb');
  // The worker is in sandbox "sb" on the portal's side; this daemon has no pool, so its spec names no sandbox (as in
  // machines.test.ts) and it runs under the machine's agent cap.
  mm.hooks = {
    specFor: (info) => ({ cwd: agentDir, settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: agentDir, protectedPaths: [], gameRepos: [] }, model: info.model }),
    handlersFor: () => ({}),
  };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sb: MachineSandbox = { id: 'sb', branch: 'sandbox/sb', base: 'origin/develop', path: agentDir, purpose: 'unused', status: 'ready', createdAt: '', unity: { state: 'stopped' }, sessionIds: [] };
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const { token } = mm.register({ id: 'mx', host: 'mx', purpose: 'unused', status: 'ready', repoPath: repo, home: tmp, portalUrl: url, sandboxes: [sb] });
  const appDir = path.join(tmp, 'app');
  const configFile = path.join(tmp, 'daemon.json');
  // Nothing of the real computer's: its own slots mailbox, temp folder and no clean-up, no Unity MCP, no Max events.
  fs.writeFileSync(
    configFile,
    JSON.stringify({ portalUrl: url, id: 'mx', token, repoPath: repo, appDir, tempDir: path.join(tmp, 'agent-tmp'), unitySlotsDir: path.join(tmp, 'slots'), claude: 'no-such-claude', maxEventsFile: null, cleanup: { everyMinutes: 0, softFreeGB: 0 }, unityMcpServer: { command: 'no-such-unity-mcp', args: [] } }),
  );
  const daemons: ChildProcess[] = [];
  let logs = '';
  const daemon = () => {
    const d = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON, configFile], { env: { ...process.env, FF_AGENT_HOST_FAKE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    d.stdout!.on('data', (c) => (logs += c));
    d.stderr!.on('data', (c) => (logs += c));
    daemons.push(d);
    return d;
  };
  /** Kill a daemon at once (TerminateProcess on Windows, SIGKILL elsewhere): nothing of it runs its shutdown. */
  const kill = async (d: ChildProcess) => {
    d.kill('SIGKILL');
    await until('the daemon gone', () => d.exitCode !== null || d.signalCode !== null);
    await until('the portal sees it gone', () => !mm.isOnline('mx'), 60_000);
  };
  const hostDir = (sid: string) => path.join(appDir, 'hosts', sid);
  const hostPid = (sid: string) => (JSON.parse(fs.readFileSync(hostFiles(hostDir(sid)).host, 'utf8')) as { pid: number }).pid;
  const said = (sid: string, kind: 'user' | 'assistant') => store.readTranscript(sid).filter((e) => e.kind === kind).map((e) => (e as { text: string }).text);
  const cleanup = async () => {
    for (const d of daemons) if (d.exitCode === null && d.signalCode === null) d.kill('SIGKILL');
    // Its hosts close when their agent stops; any left (a failed test) are ended here.
    for (const name of fs.existsSync(path.join(appDir, 'hosts')) ? fs.readdirSync(path.join(appDir, 'hosts')) : []) {
      try {
        process.kill(hostPid(name), 'SIGKILL');
      } catch {
        // gone
      }
    }
    server.close();
    await new Promise((r) => setTimeout(r, 400));
    store.flush();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  // What failed: the daemons' output, then each host's own log and files.
  const allLogs = () => {
    const hosts = path.join(appDir, 'hosts');
    const each = fs.existsSync(hosts)
      ? fs.readdirSync(hosts).map((n) => {
          const f = hostFiles(path.join(hosts, n));
          const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(-3000) : '(none)');
          return `--- host ${n}: ${fs.readdirSync(f.dir).join(', ')}\nhost.log:\n${read(f.log)}\nout.jsonl:\n${read(f.out)}\nin.jsonl:\n${read(f.in)}`;
        })
      : [];
    return [logs, ...each].join('\n');
  };
  return { store, sessions, mm, daemon, daemons, kill, hostDir, hostPid, said, cleanup, logs: allLogs };
}

test('w605: an agent mid-turn outlives its daemon being killed, the next daemon takes it back, and its turn reaches the portal; idle, it stays live too', { timeout: 180_000 }, async (t) => {
  const { store, sessions, mm, daemon, daemons, kill, hostDir, hostPid, said, cleanup, logs } = await setup();
  t.after(cleanup);
  const turnEnds: string[] = [];
  sessions.events.on('turnEnd', (_s: SessionHandle, text: string) => turnEnds.push(text));
  const d1 = daemon();
  await until('online', () => mm.isOnline('mx') && mm.protocolOf('mx') !== undefined, 60_000, logs);
  assert.ok(mm.agentHostsOf('mx'), 'its hello says its agents outlive it');

  const s = mm.createSession('mx', { kind: 'worker', sandbox: 'sb', title: 'w', permissionMode: 'default' });
  const id = s.info.id;
  sessions.send(id, '#wait 8');
  await until('mid-turn in its host', () => s.live && said(id, 'assistant').some((t) => /Working for 8 s/.test(t)), 60_000, logs);
  const pid = hostPid(id);
  assert.ok(pidAlive(pid));

  // The daemon dies mid-turn (an update or reinstall stops it; here harder than that, with no shutdown at all).
  await kill(d1);
  assert.ok(pidAlive(pid), 'the agent host runs on without its daemon');
  assert.ok(hostAlive(hostDir(id)), 'and keeps its heartbeat');

  daemon();
  await until('the turn reaches the portal through the next daemon', () => turnEnds.includes('Waited 8 s.'), 60_000, logs);
  assert.deepEqual(said(id, 'assistant'), ['Working for 8 s...', 'Waited 8 s.']);
  assert.deepEqual(said(id, 'user').length, 1, 'taken back, not resumed: no resume message');
  const seqs = store.readTranscript(id).map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'one transcript, in order');
  assert.equal(new Set(seqs).size, seqs.length, 'no event twice');

  // Idle now, its process up (2026-10-07: a reinstall stopped every idle agent): a daemon restart keeps it live.
  await until('idle', () => s.info.status === 'idle');
  assert.ok(s.live);
  await kill(daemons.at(-1)!);
  daemon();
  await until('back online', () => mm.isOnline('mx'), 60_000, logs);
  await until('reported live again', () => s.live, 20_000, logs);
  assert.equal(hostPid(id), pid, 'the same host');
  sessions.send(id, 'hello again');
  await until('answered', () => turnEnds.includes('Echo: hello again'), 30_000, logs);
  assert.equal(hostPid(id), pid, 'answered by the same agent process');

});

test('w605: a host that died with its agent is not taken back; the portal resumes the agent, and a new host carries on its conversation', { timeout: 180_000 }, async (t) => {
  const { sessions, mm, daemon, kill, hostDir, hostPid, said, cleanup, logs } = await setup();
  t.after(cleanup);
  const turnEnds: string[] = [];
  sessions.events.on('turnEnd', (_s: SessionHandle, text: string) => turnEnds.push(text));
  const d1 = daemon();
  await until('online', () => mm.isOnline('mx') && mm.protocolOf('mx') !== undefined, 60_000, logs);
  const s = mm.createSession('mx', { kind: 'worker', sandbox: 'sb', title: 'w', permissionMode: 'default' });
  const id = s.info.id;
  sessions.send(id, '#wait 60');
  await until('mid-turn', () => s.live && said(id, 'assistant').some((t) => /Working for 60 s/.test(t)), 60_000, logs);
  const conversation = s.info.sdkSessionId;
  assert.ok(conversation);
  const pid = hostPid(id);
  // The machine loses both (a crash, a power cut).
  process.kill(pid, 'SIGKILL');
  await kill(d1);
  await until('the host gone', () => !pidAlive(pid));
  const goneAt = Date.now();
  daemon();
  // The portal's resume after a dropped link (resumeCutOff), as for any agent cut off mid-turn.
  await until('resumed', () => said(id, 'user').length === 2, 60_000, logs);
  assert.match(said(id, 'user')[1], /daemon on this machine/);
  await until('the resume answered', () => turnEnds.some((t) => /^Echo: /.test(t)), 60_000, logs);
  assert.equal(s.info.sdkSessionId, conversation, 'the same conversation (claude --resume)');
  // A new host: its record written by a process started after the old one died, and alive. Not told by its pid alone:
  // Windows hands a freed pid out again, and the new host got the old one's (w636, CI: 6276 both times).
  const rec = JSON.parse(fs.readFileSync(hostFiles(hostDir(id)).host, 'utf8')) as { startedAt: string };
  assert.ok(Date.parse(rec.startedAt) >= goneAt, `in a new host (started ${rec.startedAt}, the old one gone at ${new Date(goneAt).toISOString()})`);
  assert.ok(hostAlive(hostDir(id)));
});

test('w605: LineTail reads whole lines only, any length, from an offset kept across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-linetail-'));
  try {
    const file = path.join(dir, 'out.jsonl');
    const got: string[] = [];
    const t1 = new LineTail(file, (l) => got.push(l));
    t1.poll();
    assert.deepEqual(got, [], 'no file yet');
    const long = 'x'.repeat(3 * 1024 * 1024);
    fs.appendFileSync(file, `one\r\n${long}\ntw`);
    t1.poll();
    assert.deepEqual(got.map((l: string) => l.length), [3, long.length]);
    const at = t1.position;
    fs.appendFileSync(file, 'o\nthree\n');
    // A new reader from the kept position: the half line is read whole, nothing twice.
    const again: string[] = [];
    const t2 = new LineTail(file, (l) => again.push(l), at);
    t2.poll();
    assert.deepEqual(again, ['two', 'three']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
