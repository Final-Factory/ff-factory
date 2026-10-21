// w605: agents outlive their daemon. A real daemon process runs a worker in a real agent host process (the scripted
// fake agent instead of Claude Code); the daemon is killed mid-turn and a new one takes the host back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager, type SessionHandle, type TurnEndMeta } from './sessions.ts';
import { MachineManager, RESUME_DELAY_MS } from './machines.ts';
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
async function setup(o: { env?: Record<string, string>; secretEnv?: string[]; daemonEnv?: Record<string, string> } = {}) {
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
    specFor: (info) => ({ cwd: agentDir, settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: agentDir, protectedPaths: [], gameRepos: [] }, model: info.model, ...(o.env ? { env: o.env } : {}), ...(o.secretEnv ? { secretEnv: o.secretEnv } : {}) }),
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
    const d = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON, configFile], { env: { ...process.env, FF_AGENT_HOST_FAKE: '1', ...o.daemonEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    // The link's close comes after the last update the daemon sent; then the saves land before the folder goes.
    await until('the portal sees the daemon gone', () => !mm.isOnline('mx'), 20_000).catch(() => undefined);
    store.flush();
    await store.saved();
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
  return { tmp, store, sessions, mm, daemon, daemons, kill, hostDir, hostPid, said, cleanup, logs: allLogs };
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
  // The portal resumes a cut-off agent 3 s after the daemon's hello, so the daemon's session reports come first; they are
  // sent right behind the hello, so 300 ms is plenty here.
  RESUME_DELAY_MS.value = 300;
  t.after(() => (RESUME_DELAY_MS.value = 3000));
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

test('w1469: the portal compacts an idle worker through its daemon and host; the compaction comes back marked as one, the last report kept', { timeout: 180_000 }, async (t) => {
  const { sessions, mm, daemon, cleanup, logs } = await setup();
  t.after(cleanup);
  const ends: { text: string; meta?: TurnEndMeta }[] = [];
  sessions.events.on('turnEnd', (_s: SessionHandle, text: string, meta?: TurnEndMeta) => ends.push({ text, meta }));
  daemon();
  await until('online', () => mm.isOnline('mx') && mm.protocolOf('mx') !== undefined, 60_000, logs);
  assert.ok(mm.canCompact('mx'), 'its hello offers compact');
  const s = mm.createSession('mx', { kind: 'worker', sandbox: 'sb', title: 'w', permissionMode: 'default' });
  sessions.send(s.info.id, 'big #ctx 210000');
  await until('the turn', () => ends.length === 1 && s.info.status === 'idle', 60_000, logs);
  assert.equal(s.info.contextTokens, 210_000);
  assert.ok(s.compact, 'a worker on a daemon that offers it can be compacted');
  sessions.compact(s.info.id, 'keep the PR numbers', undefined, { trigger: 'tokens', reason: 'the context passed 200,000 tokens' });
  // lastCompaction is set at the compact boundary, before the result that ends the turn: wait for that turn's end too.
  await until('compacted', () => !!s.info.lastCompaction && s.info.status === 'idle' && ends.length >= 2, 60_000, logs);
  assert.equal(s.info.lastCompaction?.trigger, 'tokens');
  assert.equal(s.info.contextTokens, 18_000);
  assert.deepEqual(ends.at(-1), { text: 'Echo: big #ctx 210000', meta: { compaction: 'tokens' } });
  assert.equal(s.info.lastResult, 'Echo: big #ctx 210000');
  assert.throws(() => sessions.compact(s.info.id, 'x'), /orchestrators/, 'a worker is never compacted on a message');
});

test("w1688: a worker that prints vault secrets, whatever they are called, leaves them masked in its transcript, its tool result and Claude Code's own transcript", { timeout: 180_000 }, async (t) => {
  // fake secrets, made here: one under a *_PASSWORD name, one under a name no rule knows, given as the vault's (secretEnv)
  const fake = () => `fake-${randomBytes(12).toString('base64url')}`;
  const A = fake();
  const B = fake();
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-claude-'));
  const { tmp, store, sessions, mm, daemon, said, cleanup, logs } = await setup({
    env: { FAKE_PASSWORD: A, FAKE_STEAM_LOGIN: B },
    secretEnv: ['FAKE_PASSWORD', 'FAKE_STEAM_LOGIN'],
    daemonEnv: { CLAUDE_CONFIG_DIR: claudeDir, FF_CLI_SCRUB: 'on' },
  });
  t.after(async () => {
    await cleanup();
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const forms = (v: string) => [v, encodeURIComponent(v), Buffer.from(v).toString('base64').replace(/=+$/, '')];
  const leaks = (text: string) => [A, B].flatMap(forms).filter((f) => text.includes(f)).length;
  const filesIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)) : []);
  const readAll = (dir: string) => filesIn(dir).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  daemon();
  await until('online', () => mm.isOnline('mx') && mm.protocolOf('mx') !== undefined, 60_000, logs);
  const s = mm.createSession('mx', { kind: 'worker', sandbox: 'sb', title: 'w', permissionMode: 'default' });
  const id = s.info.id;
  sessions.send(id, '#printenv FAKE_PASSWORD FAKE_STEAM_LOGIN');
  await until('answered', () => said(id, 'assistant').some((x) => x.startsWith('It printed')), 60_000, logs);

  // the portal's transcript, as agent_transcript and search_transcripts read it: the tool result and the reply, masked
  const events = store.readTranscript(id);
  const result = events.find((e) => e.kind === 'tool_result');
  assert.ok(result && result.kind === 'tool_result', 'the Bash call came back');
  assert.equal(leaks(JSON.stringify(events)), 0, 'no form of either value in the transcript');
  assert.equal(result.text.split('\n').length, 2);
  for (const line of result.text.split('\n')) {
    assert.match(line, /^FAKE_(?:PASSWORD|STEAM_LOGIN)=\[redacted vault secret ….{4}\] url=\[redacted vault secret ….{4}\] b64=\[redacted vault secret, base64 ….{4}\]=*$/, 'each form masked, by name and by the spec alone');
  }
  // on disk: the portal's data and the daemon's hosts, every file
  store.flush();
  await store.saved();
  assert.equal(leaks(readAll(tmp)), 0, "nothing of the portal's or the daemon's on disk holds them");
  // Claude Code's own transcript (written by the fake agent as the CLI does): masked in place by the daemon's scrubber
  await until('the CLI transcript masked', () => filesIn(claudeDir).length > 0 && leaks(readAll(claudeDir)) === 0, 30_000, () => `${logs()}\nleaks: ${leaks(readAll(claudeDir))}`);
  const cli = readAll(claudeDir);
  assert.match(cli, /\[redacted\*+\]/, 'the same-length mask');
  for (const line of cli.split('\n').filter((l) => l.trim())) JSON.parse(line);
  await until('the daemon logged it', () => /masked \d+ secret value\(s\) in place/.test(logs()), 10_000, logs);
});
