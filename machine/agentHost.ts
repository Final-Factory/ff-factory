// Agent hosts (w605, docs/machines.md "Agents outlive their daemon"). Each agent process a machine daemon runs lives in
// a host process of its own, started detached, so a daemon restart, an update or a reinstall leaves it running and the
// next daemon takes it back. The host runs the AgentSession (the Agent SDK's query, its permission prompts, the guard
// hooks); the daemon reaches it only through files in <appDir>/hosts/<session id>/, one writer each:
//
//   in.jsonl     the daemon's commands, numbered (send, interrupt, stop, mode, decide, tool answers, the editor's state)
//   out.jsonl    everything the session records, in order (its record, transcript events with their seq set here,
//                images, deltas, signals, tool calls); the daemon forwards each line to the portal and keeps how far
//                it got in daemon.offset, so a new daemon forwards exactly what the last one had not
//   host.json    the host's protocol, pid and start time; beat: its heartbeat, written every few seconds
//   state.json   the session's latest record, for a daemon that adopts the host
//   place.json   (the daemon's) the agent's folder and sandbox, without secrets
//   host.log     the host's own output
//
// The launch spec holds the run's secrets (docs/vault.md), so it reaches the host on its stdin and is never written
// down. A host therefore lives exactly as long as its agent process: idle between turns it stays up, and once the
// process ends the host closes, and the next message starts a new host that resumes the conversation.
//
//   node machine/agentHost.ts <host folder>      (started by the daemon; the start record comes on stdin)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AgentSession, setQueryForTesting, type SessionHandle, type SessionSink } from '../server/sessions.ts';
import { bus, type DistributiveOmit } from '../server/store.ts';
import { CATALOG, buildOptions, type CatalogTool, type LaunchSpec, type ToolHandler } from '../server/launch.ts';
import { SECRET_ENV, addSecretValues, redactValue } from '../server/secrets.ts';
import type { FromDaemon, SignalName } from '../server/machineProtocol.ts';
import type { DeliveredAttachment, ImageInput, PermissionMode, Requester, SessionInfo, TranscriptEvent } from '../shared/types.ts';

/** Bumped when the files' messages change so that a daemon and a host of different versions would misread each other. */
export const HOST_PROTOCOL = 1;
/** How often a host writes its heartbeat, and how old one may be before its host counts as gone. */
export const BEAT_MS = 3000;
export const BEAT_STALE_MS = 30_000;
/** How often each side reads the other's file. */
const POLL_MS = 100;
/** A host given no message to deliver this long after it started closes (a daemon died between start and send). */
const IDLE_START_MS = 2 * 60_000;
/** After its agent process ended, how long a host waits for a message that would start it again before it closes. */
const CLOSE_GRACE_MS = 1500;
/** How long a host may take to write host.json after it was started. */
const START_MS = 60_000;

const SIGNALS: SignalName[] = ['turnEnd', 'permission', 'result', 'ended', 'rateLimit'];

export const hostsDir = (appDir: string) => path.join(appDir, 'hosts');

/**
 * Follow a file one other process appends whole lines to: complete lines only, from a byte offset that can be kept
 * across restarts. Never rotated or capped (an image is one long line); the folder goes when its host is done.
 */
export class LineTail {
  private offset: number;
  private partial = Buffer.alloc(0);
  readonly file: string;
  private readonly onLine: (line: string) => void;
  constructor(file: string, onLine: (line: string) => void, offset = 0) {
    this.file = file;
    this.onLine = onLine;
    this.offset = offset;
  }

  /** How far whole lines have been read. */
  get position() {
    return this.offset - this.partial.length;
  }

  /** Read what was appended since the last call. */
  poll() {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.file, 'r');
      const size = fs.fstatSync(fd).size;
      while (this.offset < size) {
        const buf = Buffer.alloc(Math.min(size - this.offset, 8 * 1024 * 1024));
        const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
        if (n <= 0) break;
        this.offset += n;
        let data = Buffer.concat([this.partial, buf.subarray(0, n)]);
        for (let i = data.indexOf(10); i >= 0; i = data.indexOf(10)) {
          const line = data.subarray(0, i).toString('utf8').replace(/\r$/, '');
          data = data.subarray(i + 1);
          if (line.trim()) this.onLine(line);
        }
        this.partial = Buffer.from(data);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.log(new Date().toISOString(), `reading ${this.file}: ${(e as Error).message}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

export function hostFiles(dir: string) {
  const f = (n: string) => path.join(dir, n);
  return { dir, in: f('in.jsonl'), out: f('out.jsonl'), host: f('host.json'), state: f('state.json'), place: f('place.json'), offset: f('daemon.offset'), beat: f('beat'), log: f('host.log') };
}

/** What a daemon sends a host. `n` numbers them, so a host that closed says how many it carried out. */
export type HostCommand = { n: number } & (
  | { op: 'send'; info: Pick<SessionInfo, 'title' | 'model' | 'permissionMode' | 'sdkSessionId'>; text: string; from: 'human' | 'orchestrator' | 'system'; uuid: string; images?: ImageInput[]; requestedBy?: Requester; attachments?: DeliveredAttachment[] }
  | { op: 'interrupt' }
  | { op: 'stop'; onPurpose: boolean }
  | { op: 'mode'; mode: PermissionMode }
  | { op: 'decide'; requestId: string; allow: boolean; message?: string }
  | { op: 'rpc_result'; id: string; ok: boolean; text: string }
  | { op: 'editor'; up: boolean }
  | { op: 'clear_marks' }
  /** A daemon took the host back: the host says its state again and asks its unanswered tool calls again. */
  | { op: 'attach' }
);

/** What a host records, in order. */
export type HostMessage =
  | { op: 'state'; info: SessionInfo; live: boolean; lastFrom: 'human' | 'orchestrator' | 'system'; turnFrom?: 'human' | 'orchestrator' | 'system' }
  | { op: 'event'; event: TranscriptEvent }
  | { op: 'amend'; seq: number; patch: Partial<TranscriptEvent> }
  | { op: 'image'; id: string; mediaType: string; data: string }
  | { op: 'delta'; text: string }
  | { op: 'signal'; name: SignalName; arg?: unknown }
  | { op: 'rpc'; id: string; method: CatalogTool; args: Record<string, unknown> }
  | { op: 'failed'; error: string }
  /** The host is closing: its agent process ended. `consumed`: the last command it carried out. */
  | { op: 'closed'; consumed: number };

/** The start record a host reads on its stdin: the only place the launch spec (with its secrets) ever goes. */
export interface HostStart {
  hostProtocol: number;
  info: SessionInfo;
  /** The transcript's last seq so far: the host numbers on from it. */
  seq: number;
  spec: LaunchSpec;
  editorUp?: boolean;
}

/** host.json */
export interface HostRecord {
  hostProtocol: number;
  sessionId: string;
  pid: number;
  startedAt: string;
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

/** Whether a process with this pid exists (a signal-0 probe; EPERM means it exists but is not ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether the host in `dir` still runs: its pid exists and its heartbeat is fresh (a reused pid has none). */
export function hostAlive(dir: string, now = Date.now()): boolean {
  const f = hostFiles(dir);
  const rec = readJson<HostRecord>(f.host);
  if (!rec || !pidAlive(rec.pid)) return false;
  try {
    return now - fs.statSync(f.beat).mtimeMs < BEAT_STALE_MS;
  } catch {
    return false;
  }
}

/** The node flags a host needs (type stripping, quiet warnings), from the daemon's own: never a test runner's. */
export const hostNodeArgs = (execArgv = process.execArgv) => execArgv.filter((a) => /^--(experimental-strip-types|experimental-transform-types|disable-warning|no-warnings)/.test(a));

// ------------------------------------------------------------------------------------------------ the daemon's side

/** What a HostedSession needs from its daemon. */
export interface HostDeps {
  /** <appDir>/hosts */
  root: string;
  /** Forward to the portal (Daemon.out: queued while the link is down). */
  out: (msg: FromDaemon) => void;
  /** The daemon's signal listeners (they forward the signal and keep the machine awake). */
  events: EventEmitter;
  /** The tools the portal answers for this session (Daemon.handlers). */
  handlers: () => Partial<Record<CatalogTool, ToolHandler>>;
  /** The spec for a new host, resolved as the daemon would run it (stdio MCP, temp folders, the slots env). */
  spec: () => LaunchSpec;
  /** Its sandbox's editor is up (the guard's view), undefined outside sandboxes. */
  editorUp: () => boolean | undefined;
  /** The record or liveness changed (the daemon keeps the machine awake while agents run). */
  changed: () => void;
  log: (line: string) => void;
  /** Starts a host process; tests may replace it. Returns its pid. */
  launch?: (dir: string, start: HostStart) => number;
}

/** Start a host: detached (outside node's own kill-on-exit job on Windows, its own session on a Mac), output to host.log. */
export function launchHost(dir: string, start: HostStart, env: NodeJS.ProcessEnv = process.env): number {
  const f = hostFiles(dir);
  const log = fs.openSync(f.log, 'a');
  try {
    const child = spawn(process.execPath, [...hostNodeArgs(), path.join(import.meta.dirname, 'agentHost.ts'), dir], {
      cwd: dir,
      detached: true,
      stdio: ['pipe', log, log],
      windowsHide: true,
      env,
    });
    child.on('error', () => undefined);
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(JSON.stringify(start));
    child.unref();
    if (!child.pid) throw new Error('the agent host did not start');
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

/**
 * An agent whose process runs in a host (the daemon's SessionHandle for it). Its record and liveness come from the
 * host's out.jsonl; what it is asked goes to in.jsonl.
 */
export class HostedSession implements SessionHandle {
  readonly info: SessionInfo;
  lastFrom: 'human' | 'orchestrator' | 'system' = 'human';
  turnFrom?: 'human' | 'orchestrator' | 'system';
  /** The transcript's last seq this daemon forwarded. */
  seq: number;
  private liveNow = false;
  /** A host process runs (or is starting) for it. */
  private running = false;
  private n = 0;
  private sends: Extract<HostCommand, { op: 'send' }>[] = [];
  private tail?: LineTail;
  private polls = 0;
  private launchedAt = 0;
  private timer?: NodeJS.Timeout;
  private savedOffset = -1;
  private disposed = false;
  private readonly files: ReturnType<typeof hostFiles>;
  private readonly deps: HostDeps;

  constructor(info: SessionInfo, seq: number, deps: HostDeps) {
    this.info = info;
    this.seq = seq;
    this.deps = deps;
    this.files = hostFiles(path.join(deps.root, info.id));
  }

  get live() {
    return this.liveNow;
  }

  /** The host folder. */
  get dir() {
    return this.files.dir;
  }

  /**
   * Take back a host the daemon before this one started (at the daemon's start): forward what that daemon had not, from
   * its offset, and go on reading. Returns false when the host is gone; what it recorded is forwarded either way.
   */
  adopt(): boolean {
    const f = this.files;
    const state = readJson<Extract<HostMessage, { op: 'state' }>>(f.state);
    if (state) this.applyState(state, false);
    const offset = Number(readFileOr(f.offset, '0')) || 0;
    this.n = countLines(f.in);
    const alive = hostAlive(f.dir);
    this.running = alive;
    this.follow(offset);
    if (!alive) {
      // Gone with nothing more to say: whatever it recorded is forwarded; the session is not live, so the portal resumes
      // it when it was mid-turn (resumeCutOff, with its sdkSessionId) and the next message starts a new host.
      this.poll();
      this.ended('its agent host is gone');
      return false;
    }
    this.command({ op: 'attach' });
    return true;
  }

  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid: string = randomUUID(), images?: ImageInput[], requestedBy?: Requester, attachments?: DeliveredAttachment[]): string {
    const cmd = {
      op: 'send',
      info: { title: this.info.title, model: this.info.model, permissionMode: this.info.permissionMode, sdkSessionId: this.info.sdkSessionId },
      text,
      from,
      uuid,
      ...(images?.length ? { images } : {}),
      ...(requestedBy ? { requestedBy } : {}),
      ...(attachments?.length ? { attachments } : {}),
    } as const;
    if (!this.running) {
      // No host started (w665, w691): nothing runs, so it is not mid-turn. Marking it so reported a worker running for
      // hours that had nothing running, and the portal showed its request Working.
      if (!this.start(cmd)) {
        this.lastFrom = from;
        return uuid;
      }
    } else this.sends.push(this.command(cmd) as Extract<HostCommand, { op: 'send' }>);
    this.lastFrom = from;
    // As AgentSession does, at once: what the agent limits count until the host's own record comes.
    this.liveNow = true;
    this.info.status = 'running';
    this.info.turnOpenSince ??= new Date().toISOString();
    return uuid;
  }

  async interrupt() {
    if (this.running) this.command({ op: 'interrupt' });
  }

  async setMode(mode: PermissionMode) {
    this.info.permissionMode = mode;
    if (this.running) this.command({ op: 'mode', mode });
  }

  stop(onPurpose = true) {
    if (this.running) this.command({ op: 'stop', onPurpose });
  }

  decide(requestId: string, allow: boolean, message?: string) {
    if (!this.running) return false;
    this.command({ op: 'decide', requestId, allow, ...(message ? { message } : {}) });
    return true;
  }

  clearRestartMarks() {
    if (this.running) this.command({ op: 'clear_marks' });
  }

  /** Its sandbox's editor came up or went down: the guard in the host asks. */
  editor(up: boolean) {
    if (this.running) this.command({ op: 'editor', up });
  }

  /** The daemon is going (a restart, an update): stop reading, leave the host running for the next daemon. */
  detach() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.saveOffset();
  }

  /** Removed for good: once its host has closed, its folder goes. */
  dispose() {
    this.disposed = true;
    if (!this.running) this.cleanup();
  }

  /** Starts its host with `first`; false when no host process could be started (the portal is told, and the record says so). */
  private start(first: Omit<Extract<HostCommand, { op: 'send' }>, 'n'>): boolean {
    const f = this.files;
    fs.rmSync(f.dir, { recursive: true, force: true });
    fs.mkdirSync(f.dir, { recursive: true });
    const spec = this.deps.spec();
    fs.writeFileSync(f.place, JSON.stringify({ cwd: spec.cwd, ...(spec.sandbox ? { sandbox: spec.sandbox } : {}) }));
    fs.writeFileSync(f.offset, '0');
    this.n = 0;
    this.savedOffset = 0;
    this.sends = [this.command(first) as Extract<HostCommand, { op: 'send' }>];
    const start: HostStart = { hostProtocol: HOST_PROTOCOL, info: { ...this.info, pendingPermissions: [] }, seq: this.seq, spec, editorUp: this.deps.editorUp() };
    this.running = true;
    this.launchedAt = Date.now();
    this.follow(0);
    try {
      const pid = (this.deps.launch ?? launchHost)(f.dir, start);
      this.deps.log(`agent host for ${this.info.id} started, pid ${pid}`);
      return true;
    } catch (e) {
      const error = `could not start its agent host: ${(e as Error).message}`;
      this.running = false;
      this.liveNow = false;
      clearInterval(this.timer);
      this.timer = undefined;
      Object.assign(this.info, { status: 'error', statusDetail: error });
      this.deps.log(`agent ${this.info.id}: ${error}`);
      this.deps.out({ type: 'failed', sessionId: this.info.id, error, reason: 'host_start' });
      return false;
    }
  }

  private command(c: DistributiveOmit<HostCommand, 'n'>): HostCommand {
    const cmd = { ...c, n: ++this.n } as HostCommand;
    fs.appendFileSync(this.files.in, JSON.stringify(cmd) + '\n');
    return cmd;
  }

  private follow(offset: number) {
    clearInterval(this.timer);
    this.tail = new LineTail(this.files.out, (line) => this.onLine(line), offset);
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  private poll() {
    if (!this.tail) return;
    this.tail.poll();
    this.saveOffset();
    // A host that died without closing (a crash, the machine's power): what it recorded is forwarded above. Looked at
    // every 2 s. One that has not written host.json yet is still starting, for up to START_MS.
    if (++this.polls % 20 !== 0 || !this.running) return;
    const started = fs.existsSync(this.files.host);
    if (started ? !hostAlive(this.files.dir) : Date.now() - this.launchedAt > START_MS) {
      this.tail.poll();
      if (this.running) this.ended(started ? 'its agent host stopped unexpectedly' : `its agent host did not start (see ${this.files.log})`);
    }
  }

  private saveOffset() {
    const at = this.tail?.position ?? 0;
    if (at === this.savedOffset || !fs.existsSync(this.files.dir)) return;
    try {
      fs.writeFileSync(this.files.offset, String(at));
      this.savedOffset = at;
    } catch {
      // kept in memory; the next poll tries again
    }
  }

  private onLine(line: string) {
    let m: HostMessage;
    try {
      m = JSON.parse(line) as HostMessage;
    } catch {
      this.deps.log(`agent host ${this.info.id}: a line that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    const id = this.info.id;
    switch (m.op) {
      case 'state':
        this.applyState(m, true);
        return;
      case 'event':
        this.seq = Math.max(this.seq, m.event.seq);
        this.deps.out({ type: 'event', sessionId: id, event: m.event });
        return;
      case 'amend':
        this.deps.out({ type: 'amend', sessionId: id, seq: m.seq, patch: m.patch });
        return;
      case 'image':
        this.deps.out({ type: 'image', sessionId: id, id: m.id, mediaType: m.mediaType, data: m.data });
        return;
      case 'delta':
        this.deps.out({ type: 'delta', sessionId: id, text: m.text });
        return;
      case 'signal':
        this.deps.events.emit(m.name, this, m.arg);
        return;
      case 'failed':
        this.deps.out({ type: 'failed', sessionId: id, error: m.error });
        return;
      case 'rpc': {
        const h = this.deps.handlers()[m.method];
        const answer = (ok: boolean, text: string) => this.running && this.command({ op: 'rpc_result', id: m.id, ok, text });
        if (!h) answer(false, `this machine's daemon has no tool ${m.method}`);
        else
          void h(m.args).then(
            (text) => answer(true, text),
            (e) => answer(false, (e as Error).message),
          );
        return;
      }
      case 'closed': {
        this.running = false;
        // Messages it was given after it decided to close: a new host carries them (sent again, in order).
        const left = this.sends.filter((c) => c.n > m.consumed);
        this.sends = [];
        if (left.length && !this.disposed) {
          this.deps.log(`agent host ${id} closed with ${left.length} message(s) not delivered; starting a new one for them`);
          const [first, ...rest] = left;
          try {
            if (this.start(withoutN(first))) for (const c of rest) this.sends.push(this.command(withoutN(c)) as Extract<HostCommand, { op: 'send' }>);
          } catch (e) {
            this.deps.out({ type: 'failed', sessionId: id, error: `could not deliver a message: ${(e as Error).message}` });
          }
          return;
        }
        this.ended(undefined);
        return;
      }
    }
  }

  private applyState(m: Extract<HostMessage, { op: 'state' }>, forward: boolean) {
    // The host's record replaces the copy here, cleared fields included (the portal clears what is absent).
    for (const k of Object.keys(this.info)) if (!(k in m.info)) delete (this.info as unknown as Record<string, unknown>)[k];
    Object.assign(this.info, m.info);
    this.liveNow = m.live;
    this.lastFrom = m.lastFrom;
    this.turnFrom = m.turnFrom;
    if (forward) {
      this.deps.out({ type: 'session', info: this.info, live: this.liveNow });
      this.deps.changed();
    }
  }

  /** Its host is gone: the session is not live. `why` (a host that did not close by itself) goes in its record. */
  private ended(why: string | undefined) {
    const was = this.liveNow;
    this.running = false;
    this.liveNow = false;
    clearInterval(this.timer);
    this.timer = undefined;
    if (why) {
      this.deps.log(`agent ${this.info.id}: ${why}`);
      // Mid-turn marks stay (turnOpenSince): the portal decides whether to resume it.
      if (this.info.status === 'running' || this.info.status === 'starting' || this.info.status === 'waiting_permission') Object.assign(this.info, { status: 'stopped', statusDetail: why, pendingPermissions: [] });
      this.deps.out({ type: 'session', info: this.info, live: false });
      if (was) this.deps.events.emit('ended', this);
    }
    this.deps.changed();
    this.cleanup();
  }

  private cleanup() {
    clearInterval(this.timer);
    this.timer = undefined;
    try {
      fs.rmSync(this.files.dir, { recursive: true, force: true });
    } catch (e) {
      this.deps.log(`agent host ${this.info.id}: could not remove ${this.files.dir}: ${(e as Error).message}`);
    }
  }
}

const withoutN = ({ n: _n, ...c }: Extract<HostCommand, { op: 'send' }>) => c;

function readFileOr(file: string, or: string) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return or;
  }
}

function countLines(file: string) {
  const t = readFileOr(file, '');
  let n = 0;
  for (const l of t.split('\n')) if (l.trim()) n = Math.max(n, Number((JSON.parse(l) as { n?: number }).n) || 0);
  return n;
}

/** The host folders a daemon finds at its start: each a session whose agent may still run. */
export function hostFolders(root: string): { sessionId: string; dir: string; record?: HostRecord }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.map((n) => ({ sessionId: n, dir: path.join(root, n), record: readJson<HostRecord>(path.join(root, n, 'host.json')) }));
}

/** The session's last record a host wrote (state.json), or undefined before its first. */
export const readHostState = (dir: string) => readJson<Extract<HostMessage, { op: 'state' }>>(hostFiles(dir).state);

/** A host folder's place (its folder and sandbox), for the agent limits and the attachments' Inbox. */
export const hostPlace = (dir: string) => readJson<{ cwd: string; sandbox?: string }>(hostFiles(dir).place);

// ------------------------------------------------------------------------------------------------ the host process

/** The host: run the session from the start record, carry out the daemon's commands, record everything to out.jsonl. */
export async function runHost(dir: string, start: HostStart): Promise<void> {
  const f = hostFiles(dir);
  const id = start.info.id;
  addSecretValues(Object.entries(start.spec.env ?? {}).filter(([k]) => SECRET_ENV.test(k)).map(([, v]) => v));
  fs.writeFileSync(f.host, JSON.stringify({ hostProtocol: HOST_PROTOCOL, sessionId: id, pid: process.pid, startedAt: new Date().toISOString() } satisfies HostRecord));
  const beat = () => {
    try {
      fs.writeFileSync(f.beat, String(Date.now()));
    } catch {
      // the folder is gone: the daemon removed it, so nobody reads this host any more
    }
  };
  beat();
  const beatTimer = setInterval(beat, BEAT_MS);
  // Never a secret on disk (the vault's tokens, a Claude OAuth token), as the portal never keeps one either.
  const out = (m: HostMessage) => fs.appendFileSync(f.out, JSON.stringify(redactValue(m)) + '\n');
  let seq = start.seq;
  let editorUp = !!start.editorUp;
  const spec = start.spec;
  const asked = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void; msg: Extract<HostMessage, { op: 'rpc' }> }>();
  const handlers = Object.fromEntries(
    (Object.keys(CATALOG) as CatalogTool[]).map((method) => [
      method,
      (args: Record<string, unknown>) =>
        new Promise<string>((resolve, reject) => {
          const msg = { op: 'rpc', id: randomUUID(), method, args } as const;
          asked.set(msg.id, { resolve, reject, msg });
          out(msg);
        }),
    ]),
  ) as Partial<Record<CatalogTool, ToolHandler>>;
  const events = new EventEmitter();
  let s: AgentSession | undefined;
  const state = () => {
    if (!s) return;
    const m: HostMessage = { op: 'state', info: s.info, live: s.live, lastFrom: s.lastFrom, turnFrom: s.turnFrom };
    out(m);
    try {
      fs.writeFileSync(`${f.state}.tmp`, JSON.stringify(redactValue(m)));
      fs.renameSync(`${f.state}.tmp`, f.state);
    } catch {
      // state.json is only the adopting daemon's start; out.jsonl has every record
    }
  };
  const sink: SessionSink = {
    putSession: () => state(),
    append: (_sid: string, e: DistributiveOmit<TranscriptEvent, 'seq' | 't'>) => {
      const full = { ...e, seq: ++seq, t: new Date().toISOString() } as TranscriptEvent;
      out({ op: 'event', event: full });
      return full;
    },
    amend: (_sid: string, at: number, patch: Partial<TranscriptEvent>) => out({ op: 'amend', seq: at, patch }),
    saveImage: (_sid: string, mediaType: string, data: string) => {
      const imageId = randomUUID();
      out({ op: 'image', id: imageId, mediaType, data });
      return imageId;
    },
  } as SessionSink;
  s = new AgentSession(start.info, sink, () => buildOptions(spec, handlers, process.env, spec.sandbox ? () => editorUp : undefined), events);
  const session = s;
  bus.on('event', (e) => {
    if (e.type === 'delta' && e.sessionId === id) out({ op: 'delta', text: e.text });
  });

  let consumed = 0;
  let started = false;
  let closing: NodeJS.Timeout | undefined;
  const close = () => {
    if (closing) return;
    // A message may still come (the daemon had not read the end yet): wait a moment, read once more, then close.
    closing = setTimeout(() => {
      tail.poll();
      if (session.live) {
        closing = undefined;
        return;
      }
      out({ op: 'closed', consumed });
      clearInterval(beatTimer);
      clearInterval(pollTimer);
      setTimeout(() => process.exit(0), 200);
    }, CLOSE_GRACE_MS);
  };
  for (const name of SIGNALS) {
    events.on(name, (_h: SessionHandle, arg?: unknown) => {
      out({ op: 'signal', name, ...(name === 'permission' || arg === undefined ? {} : { arg }) });
      if (name === 'ended') {
        state();
        close();
      }
    });
  }

  const apply = (c: HostCommand) => {
    consumed = Math.max(consumed, c.n);
    switch (c.op) {
      case 'send':
        started = true;
        if (closing) {
          clearTimeout(closing);
          closing = undefined;
        }
        // The portal owns naming, model and mode; a resume id only if this host has none, as the daemon did.
        if (!session.live) Object.assign(session.info, { title: c.info.title, model: c.info.model, permissionMode: c.info.permissionMode, sdkSessionId: session.info.sdkSessionId ?? c.info.sdkSessionId });
        try {
          session.send(c.text, c.from, c.uuid, c.images, c.requestedBy, c.attachments);
        } catch (e) {
          out({ op: 'failed', error: (e as Error).message });
          state();
          if (!session.live) close();
        }
        return;
      case 'interrupt':
        void session.interrupt();
        return;
      case 'stop':
        session.stop(c.onPurpose);
        if (!session.live) close();
        return;
      case 'mode':
        void session.setMode(c.mode);
        return;
      case 'decide':
        session.decide(c.requestId, c.allow, c.message);
        return;
      case 'rpc_result': {
        const p = asked.get(c.id);
        if (!p) return;
        asked.delete(c.id);
        if (c.ok) p.resolve(c.text);
        else p.reject(new Error(c.text));
        return;
      }
      case 'editor':
        editorUp = c.up;
        return;
      case 'clear_marks':
        session.clearRestartMarks();
        return;
      case 'attach':
        // A new daemon: its state, and the tool calls the last one took but never answered (it stopped meanwhile).
        state();
        for (const p of asked.values()) out(p.msg);
        return;
    }
  };
  const tail = new LineTail(f.in, (line) => {
    try {
      apply(JSON.parse(line) as HostCommand);
    } catch (e) {
      console.log(new Date().toISOString(), `bad command: ${(e as Error).message}`);
    }
  });
  const pollTimer = setInterval(() => tail.poll(), POLL_MS);
  tail.poll();
  // Started and never given a message (its daemon died in between): nothing to keep running.
  setTimeout(() => {
    if (!started && !session.live) close();
  }, IDLE_START_MS).unref();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Run when started directly (by the daemon), not when imported.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dir = process.argv[2];
  const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
  process.on('uncaughtException', (e) => log('UNCAUGHT (kept running):', e));
  process.on('unhandledRejection', (e) => log('UNHANDLED REJECTION (kept running):', e));
  void (async () => {
    const start = JSON.parse(await readStdin()) as HostStart;
    if (start.hostProtocol !== HOST_PROTOCOL) {
      log(`host protocol ${start.hostProtocol} from the daemon; this host speaks ${HOST_PROTOCOL}`);
      process.exit(2);
    }
    // Tests only (server/agentHost.test.ts): the scripted fake agent instead of Claude Code. Its module is not shipped.
    if (process.env.FF_AGENT_HOST_FAKE === '1') {
      const fake = path.join(import.meta.dirname, '..', 'e2e', 'fakeAgent.ts');
      setQueryForTesting((await import(pathToFileURL(fake).href)).fakeQuery({ stepMs: 5 }) as never);
    }
    log(`agent host for ${start.info.id}, pid ${process.pid}`);
    await runHost(dir, start);
  })().catch((e) => {
    log('agent host failed to start:', e);
    process.exit(1);
  });
}
