// w5545 (item 9 of the w5451 rogue-worker audit, for lothsahn): Unity slot requests and bench tickets go only through the
// daemon's own calls, keyed to the calling session, never through files a worker writes (docs/unity-lifecycle.md,
// "Asking the daemon"). This is the channel: an HTTP server on 127.0.0.1 (a port the OS picks, named in
// <appDir>/rpc.json), each call carrying the token the daemon gave its agent in FF_DAEMON_TOKEN. The token names the
// session and its sandbox and is signed with a key only the daemon writes (<root>/secrets/daemon-rpc.key), so a worker
// can act as itself and no one else: the session, the sandbox and so the priority (priorities.json, keyed by session)
// come from the token, never from the body.
//
// Limits, said plainly: a process of the same OS user that reads the key file or another agent's environment
// (/proc/<pid>/environ) can make any token. The fences (landlock, low integrity, seatbelt) keep workers from writing the
// daemon's folder and secrets, not from reading them; the harness's read guard keeps an agent's own commands off the
// secrets folder. What this closes is the open mailbox: any file a worker dropped in <root>/unity-slots or
// <root>/tmp/bench.queue was a request or a ticket with whatever holder, session and priority it named.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Who called: the session the token was made for, and the sandbox it ran in (none for a standing agent or the daemon's own). */
export interface Caller {
  session: string;
  sandbox?: string;
}

/** What rpc.json says: where the server listens, and the bench lock the daemon keeps (workers read it from here). */
export interface RpcInfo {
  v: 1;
  port: number;
  pid: number;
  at: string;
  /** The bench lock dir under the daemon's folder (machine/benchLock.ts benchLockDir); its queue is beside it. */
  benchLock?: string;
}

export const rpcInfoFile = (appDir: string) => path.join(appDir, 'rpc.json');
export const rpcKeyFile = (root: string) => path.join(root, 'secrets', 'daemon-rpc.key');

/** The env names a client reads. */
export const RPC_ENV = 'FF_DAEMON_RPC';
export const TOKEN_ENV = 'FF_DAEMON_TOKEN';

/** The signing key: made once (32 random bytes, owner-only) and kept, so tokens in running agents outlive a daemon restart. */
export function loadRpcKey(file: string): Buffer {
  try {
    const k = fs.readFileSync(file);
    if (k.length >= 32) return k;
  } catch {
    // first start
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const k = randomBytes(32);
  fs.writeFileSync(file, k, { mode: 0o600 });
  return k;
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const sign = (key: Buffer, body: string) => createHmac('sha256', key).update(`ff-daemon-rpc.v1.${body}`).digest('base64url');
const SESSION = /^[A-Za-z0-9:_.-]{1,80}$/;

/** A token for a session: `v1.<base64url {s, b}>.<hmac>`. */
export function makeToken(key: Buffer, c: Caller): string {
  if (!SESSION.test(c.session) || (c.sandbox !== undefined && !SESSION.test(c.sandbox))) throw new Error(`no token for session "${c.session}"`);
  const body = b64(JSON.stringify({ s: c.session, ...(c.sandbox ? { b: c.sandbox } : {}) }));
  return `v1.${body}.${sign(key, body)}`;
}

/** The caller a token names, or undefined when it is not one this key signed. */
export function readToken(key: Buffer, token: string | undefined): Caller | undefined {
  const m = /^v1\.([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/.exec(token ?? '');
  if (!m) return undefined;
  const want = Buffer.from(sign(key, m[1]));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  try {
    const j = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as { s?: unknown; b?: unknown };
    if (typeof j.s !== 'string' || !SESSION.test(j.s)) return undefined;
    return { session: j.s, ...(typeof j.b === 'string' && SESSION.test(j.b) ? { sandbox: j.b } : {}) };
  } catch {
    return undefined;
  }
}

/** A refusal the caller hears as is (HTTP 400 or 403). */
export class RpcRefused extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type RpcHandler = (caller: Caller, body: Record<string, unknown>) => unknown;

export interface DaemonRpcOptions {
  key: Buffer;
  /** Where rpc.json goes (the daemon's folder). */
  infoFile: string;
  handlers: Record<string, RpcHandler>;
  benchLock?: string;
  log?: (line: string) => void;
  /** Tests: a fixed port. */
  port?: number;
}

const MAX_BODY = 16 * 1024;

/** The daemon's side: one server, one route per op (`POST /v1/<op>`), JSON both ways. */
export class DaemonRpc {
  private server?: http.Server;
  private readonly o: DaemonRpcOptions;
  port = 0;

  constructor(o: DaemonRpcOptions) {
    this.o = o;
  }

  start(): Promise<number> {
    const server = http.createServer((req, res) => void this.serve(req, res));
    this.server = server;
    server.unref();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.o.port ?? 0, '127.0.0.1', () => {
        const a = server.address();
        this.port = typeof a === 'object' && a ? a.port : 0;
        const info: RpcInfo = { v: 1, port: this.port, pid: process.pid, at: new Date().toISOString(), ...(this.o.benchLock ? { benchLock: this.o.benchLock } : {}) };
        fs.mkdirSync(path.dirname(this.o.infoFile), { recursive: true });
        const tmp = `${this.o.infoFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(info, null, 1));
        fs.renameSync(tmp, this.o.infoFile);
        this.o.log?.(`daemon rpc: listening on 127.0.0.1:${this.port} (${this.o.infoFile}), ops ${Object.keys(this.o.handlers).sort().join(', ')}`);
        resolve(this.port);
      });
    });
  }

  close() {
    this.server?.close();
    this.server = undefined;
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse) {
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const m = /^\/v1\/([a-z]+\/[a-z]+)$/.exec(req.url ?? '');
    const handler = m ? this.o.handlers[m[1]] : undefined;
    if (req.method !== 'POST' || !handler) return answer(404, { ok: false, error: `no such call: ${req.method} ${req.url}` });
    const auth = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
    const caller = readToken(this.o.key, auth?.[1]);
    if (!caller) return answer(403, { ok: false, error: `no valid ${TOKEN_ENV}: only FF Factory's own agents and the processes they start may ask` });
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) return answer(413, { ok: false, error: 'body too large' });
      }
      const body = raw ? (JSON.parse(raw) as unknown) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) return answer(400, { ok: false, error: 'the body is a JSON object' });
      const out = await handler(caller, body as Record<string, unknown>);
      answer(200, { ok: true, ...(out && typeof out === 'object' ? out : {}) });
    } catch (e) {
      const err = e as Error;
      if (e instanceof RpcRefused) return answer(e.status, { ok: false, error: err.message });
      this.o.log?.(`daemon rpc: ${m![1]} for ${caller.session} failed: ${err.stack ?? err.message}`);
      answer(500, { ok: false, error: err.message });
    }
  }
}

// ---------------------------------------------------------------- the client (unity-slot, and the game repo's scripts mirror it)

/** Whether this process can ask the daemon (its agent gave it a token and the daemon's rpc.json). */
export const rpcAvailable = (env: NodeJS.ProcessEnv = process.env) => !!(env[RPC_ENV] && env[TOKEN_ENV]);

export function readRpcInfo(env: NodeJS.ProcessEnv = process.env): RpcInfo | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(env[RPC_ENV] ?? '', 'utf8')) as RpcInfo;
    return j && j.v === 1 && Number.isInteger(j.port) && j.port > 0 ? j : undefined;
  } catch {
    return undefined;
  }
}

export class RpcUnavailable extends Error {}

/** One call. Throws RpcUnavailable when the daemon cannot be reached, RpcRefused (with its words) when it says no. */
export async function rpcCall<T = Record<string, unknown>>(op: string, body: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env, timeoutMs = 15_000): Promise<T> {
  const info = readRpcInfo(env);
  if (!info) throw new RpcUnavailable(`no daemon rpc (${env[RPC_ENV] || `${RPC_ENV} unset`} missing or unreadable)`);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}/v1/${op}`, { method: 'POST', headers: { authorization: `Bearer ${env[TOKEN_ENV] ?? ''}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    throw new RpcUnavailable(`the daemon did not answer on 127.0.0.1:${info.port}: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
  let j: { ok?: boolean; error?: string } & Record<string, unknown>;
  try {
    j = (await res.json()) as typeof j;
  } catch {
    throw new RpcUnavailable(`the daemon answered ${res.status} with no JSON`);
  }
  if (!j.ok) throw new RpcRefused(j.error ?? `refused (${res.status})`, res.status);
  return j as T;
}
