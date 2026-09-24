import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager, type SessionHandle, type SessionSink } from './sessions.ts';
import { MachineManager, RemoteSession } from './machines.ts';
import { Daemon } from '../machine/daemon.ts';
import { checkOwnCheckout } from './guard.ts';
import { agentPath, nodeSupport, plist } from './machineDeploy.ts';
import type { Config } from './config.ts';
import type { ImageInput, PermissionMode, SessionInfo, TranscriptEvent } from '../shared/types.ts';

/** Stands in for AgentSession on the daemon: answers every message with "echo <text>". */
class FakeAgent implements SessionHandle {
  info: SessionInfo;
  live = false;
  lastFrom: 'human' | 'orchestrator' | 'system' = 'human';
  private readonly sink: SessionSink;
  private readonly events: EventEmitter;
  constructor(info: SessionInfo, sink: SessionSink, _o: unknown, events: EventEmitter) {
    this.info = info;
    this.sink = sink;
    this.events = events;
  }
  images: ImageInput[] = [];
  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid = 'u', images: ImageInput[] = []) {
    this.live = true;
    this.images = images;
    this.sink.append(this.info.id, { kind: 'user', text, from, uuid, images: images.map((i) => ({ id: i.id ?? '?', mediaType: i.mediaType })) });
    if (text === 'screenshot') {
      // A tool that returns an image: the daemon ships it to the portal before the event naming it.
      const id = this.sink.saveImage(this.info.id, 'image/png', 'iVBORw0KGgo=');
      this.sink.append(this.info.id, { kind: 'tool_result', toolUseId: 't', isError: false, text: '[image]', images: [{ id, mediaType: 'image/png' }] });
    }
    this.info.status = 'running';
    this.sink.putSession(this.info);
    setTimeout(() => {
      this.sink.append(this.info.id, { kind: 'assistant', text: `echo ${text}` });
      Object.assign(this.info, { status: 'idle', costUsd: this.info.costUsd + 0.01, turns: this.info.turns + 1 });
      this.sink.putSession(this.info);
      this.events.emit('result', this, 'success');
      this.events.emit('turnEnd', this, `echo ${text}`);
    }, 20);
    return uuid;
  }
  async interrupt() {}
  async setMode(m: PermissionMode) {
    this.info.permissionMode = m;
  }
  stop() {
    if (!this.live) return;
    this.live = false;
    this.info.status = 'stopped';
    this.sink.putSession(this.info);
    this.events.emit('ended', this);
  }
  decide() {
    return false;
  }
}

const until = async (what: string, cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-machines-'));
  const cfg = { dataDir: tmp, limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' } } as unknown as Config;
  const store = new Store(tmp);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  mm.hooks = {
    specFor: (info) => ({ cwd: tmp, settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: tmp, protectedPaths: [], gameRepos: [] }, model: info.model }),
    handlersFor: (_info, m) => ({ set_label: async (a) => mm.setPurpose(m.id, String(a.purpose)).purpose }),
  };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'mx', host: 'mx', purpose: 'unused', status: 'ready', repoPath: tmp, home: tmp, portalUrl: url, maxSessions: 1 });
  const daemons: Daemon[] = [];
  const daemon = (tok = token) => {
    const d = new Daemon({ portalUrl: url, id: 'mx', token: tok, repoPath: tmp, claude: 'definitely-not-a-claude-binary', maxSessions: 1 }, (i, s, o, e) => new FakeAgent(i, s, o, e));
    daemons.push(d);
    d.start();
    return d;
  };
  const cleanup = async () => {
    for (const d of daemons) d.shutdown();
    await until('disconnect', () => !mm.isOnline('mx')).catch(() => undefined);
    server.close();
    // Let the last session/machine updates (and their debounced saves) land before the folder goes.
    await new Promise((r) => setTimeout(r, 400));
    store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { store, sessions, mm, daemon, token, cleanup };
}

test('machine: a daemon connects, runs a session, and everything it records lands in the portal', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  daemon();
  await until('online', () => mm.isOnline('mx') && !!store.machines.get('mx')?.info);
  assert.equal(store.machines.get('mx')!.online, true);

  const turnEnds: string[] = [];
  sessions.events.on('turnEnd', (s: SessionHandle, text: string) => turnEnds.push(`${s.info.id}:${text}`));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  assert.ok(s instanceof RemoteSession);
  sessions.send(s.info.id, 'hello');
  await until('turn end', () => turnEnds.length === 1);
  assert.equal(turnEnds[0], `${s.info.id}:echo hello`);
  const events = store.readTranscript(s.info.id);
  assert.deepEqual(
    events.map((e) => [e.seq, e.kind]),
    [
      [1, 'user'],
      [2, 'assistant'],
    ],
  );
  assert.equal(s.info.status, 'idle');
  assert.equal(s.info.costUsd, 0.01);
  assert.equal(s.live, true, 'the process stays up between turns, like a local worker');
  assert.equal(sessions.liveAgents(), 0, "a machine's agents do not count toward this host's limit");
  assert.equal(mm.liveCount('mx'), 1);

  // The machine's own limit (1): a second session cannot start while the first is live.
  const s2 = mm.createSession('mx', { kind: 'worker', title: 'w2', permissionMode: 'default' });
  assert.throws(() => sessions.send(s2.info.id, 'x'), /already 1 agents running on mx/);
  s.stop();
  await until('stopped', () => !s.live);
  sessions.send(s2.info.id, 'second');
  await until('second turn', () => turnEnds.length === 2);
});

test('machine: offline sessions show stopped and refuse messages; a reconnect resumes the transcript numbering', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  const d = daemon();
  await until('online', () => mm.isOnline('mx'));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  const ended: string[] = [];
  sessions.events.on('ended', (h: SessionHandle) => ended.push(h.info.id));
  sessions.send(s.info.id, 'one');
  await until('idle', () => s.info.status === 'idle');

  d.shutdown();
  await until('offline', () => !mm.isOnline('mx'));
  assert.equal(store.machines.get('mx')!.online, false);
  assert.equal(s.live, false);
  assert.ok(ended.includes(s.info.id), 'standing agents hear that the run ended');
  assert.throws(() => sessions.send(s.info.id, 'two'), /machine mx is offline/);

  daemon();
  await until('online again', () => mm.isOnline('mx'));
  sessions.send(s.info.id, 'three');
  await until('answered', () => store.readTranscript(s.info.id).length === 4);
  assert.deepEqual(
    store.readTranscript(s.info.id).map((e) => e.seq),
    [1, 2, 3, 4],
  );
});

test('machine: images go to the agent with ids the portal already stored; images it produces come back', async (t) => {
  const { store, sessions, mm, daemon, cleanup } = await setup();
  t.after(cleanup);
  daemon();
  await until('online', () => mm.isOnline('mx'));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  sessions.send(s.info.id, 'look', 'human', [{ mediaType: 'image/jpeg', data: '/9j/4AAQ' }]);
  await until('answered', () => store.readTranscript(s.info.id).some((e) => e.kind === 'assistant'));
  const user = store.readTranscript(s.info.id).find((e) => e.kind === 'user') as Extract<TranscriptEvent, { kind: 'user' }>;
  assert.equal(user.images?.length, 1);
  assert.ok(store.imagePath(s.info.id, user.images![0].id), 'stored on the portal before it was sent');

  sessions.send(s.info.id, 'screenshot');
  await until('tool result', () => store.readTranscript(s.info.id).some((e) => e.kind === 'tool_result'));
  const tr = store.readTranscript(s.info.id).find((e) => e.kind === 'tool_result') as Extract<TranscriptEvent, { kind: 'tool_result' }>;
  assert.ok(store.imagePath(s.info.id, tr.images![0].id), 'the image arrived before the event that names it');
});

test('machine: a bad token is refused; tool calls go back to the portal', async (t) => {
  const { store, mm, daemon, token, cleanup } = await setup();
  t.after(cleanup);
  const bad = daemon(token.slice(0, -4) + 'AAAA');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mm.isOnline('mx'), false);
  assert.equal(bad.connected, false);
  bad.shutdown();
  assert.equal(mm.authenticate(`Bearer ${token}`), 'mx');
  assert.equal(mm.authenticate(`Bearer ${token}x`), undefined);
  assert.equal(mm.authenticate('Bearer ffsb_whatever'), undefined);

  const d = daemon();
  await until('online', () => mm.isOnline('mx'));
  const s = mm.createSession('mx', { kind: 'worker', title: 'w', permissionMode: 'default' });
  const handlers = (d as unknown as { handlers(id: string): { set_label(a: Record<string, unknown>): Promise<string> } }).handlers(s.info.id);
  assert.equal(await handlers.set_label({ purpose: 'shader pass' }), 'shader pass');
  assert.equal(store.machines.get('mx')!.purpose, 'shader pass');
});

test("own checkout: nothing that loses the user's work; branch switches only on a clean tree", () => {
  const clean = () => true;
  const dirty = () => false;
  for (const cmd of [
    'git stash',
    'git stash push -m x',
    'git stash pop',
    'git reset --hard origin/develop',
    'git clean -fd',
    'git checkout -- Assets/x.cs',
    'git checkout .',
    'git restore Assets/x.cs',
    'git add -A',
    'git add .',
    'git add --all',
    'git commit -am "x"',
    'git commit -a -m x',
    'cd sub && git switch -f other',
  ]) {
    assert.ok(checkOwnCheckout(cmd, '/r', clean), cmd);
  }
  for (const cmd of ['git stash list', 'git reset HEAD Assets/x.cs', 'git restore --staged Assets/x.cs', 'git add Assets/x.cs', 'git commit -m x', 'git clean -n', 'git status', 'git checkout -b feature/x', 'git switch develop']) {
    assert.equal(checkOwnCheckout(cmd, '/r', clean), undefined, cmd);
  }
  assert.match(checkOwnCheckout('git checkout develop', '/r', dirty)!, /uncommitted changes/);
  assert.match(checkOwnCheckout('git -C /other switch -c x', '/r', dirty)!, /stop and ask/i);
  assert.equal(checkOwnCheckout('git commit -m x', '/r', dirty), undefined, 'committing your own staged files is fine on a dirty tree');
});

test('deploy: node support and the LaunchAgent', () => {
  assert.deepEqual(nodeSupport('22.15.0'), { ok: true, flag: true });
  assert.deepEqual(nodeSupport('26.5.0'), { ok: true, flag: false });
  assert.deepEqual(nodeSupport('23.6.0'), { ok: true, flag: false });
  assert.equal(nodeSupport('22.5.1').ok, false);
  assert.equal(nodeSupport(undefined).ok, false);
  const p = plist('/Users/b', '/Users/b/.nvm/versions/node/v22.15.0/bin/node', true);
  assert.match(p, /<string>--experimental-strip-types<\/string>/);
  assert.match(p, /<string>\/Users\/b\/.ff-factory\/app\/machine\/daemon.ts<\/string>/);
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
  assert.match(p, /\/Users\/b\/.nvm\/versions\/node\/v22.15.0\/bin:/);
  // The user's shell PATH comes through (~/bin/gh on the M5), with Homebrew and the system dirs after it.
  const path = agentPath('/Users/b', '/opt/homebrew/bin/node', '/Users/b/bin:~/.dotnet/tools:/opt/homebrew/bin::relative');
  assert.equal(path, '/opt/homebrew/bin:/Users/b/bin:/Users/b/.dotnet/tools:/Users/b/.local/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.match(plist('/Users/b', '/opt/homebrew/bin/node', false, '/Users/b/bin'), /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/Users\/b\/bin:/);
});

test('deploy: the game clone is recognised by the owner/name of config repo.url', async () => {
  const { repoSlug } = await import('./machineDeploy.ts');
  assert.equal(repoSlug('https://github.com/Some-Org/SomeGame.git'), 'Some-Org/SomeGame');
  assert.equal(repoSlug('git@github.com:Some-Org/SomeGame.git'), 'Some-Org/SomeGame');
  assert.equal(repoSlug('https://github.com/Some-Org/SomeGame/'), 'Some-Org/SomeGame');
  assert.equal(repoSlug('not a url'), undefined);
});
