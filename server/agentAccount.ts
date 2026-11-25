import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { opsHeader, sdkVersion } from './opsWorker.ts';
import { tokenPipeSpawner } from './tokenPipe.ts';

/**
 * The portal VM's agents as their own OS account (w5598, docs/vault.md "In the VM"). The orchestrators, the dispatcher and
 * the bug-thread judge used to run as the portal's account (fff), which may read /proc/<pid>/environ of every fff process:
 * the portal's own git and gh carry GH_TOKEN there while they run. fff-portal.service names fff-agent.socket in
 * FFF_AGENT_SOCKET; each agent's Claude Code is started through it (one connection each, deploy/vm/guest/fff-agent-launch)
 * as fff-agent, which reads no fff process's /proc and sees only the folders its unit binds (fff-agent@.service).
 *
 * Never a lockout (lothsahn, w5598: the owners are away, and a portal whose orchestrators or dispatcher cannot start stops
 * all work): any failure before the launcher's "OK" (no socket, a refused connection, its "ERR <why>", no answer) starts
 * that agent as before (tokenPipeSpawner, as fff) and alerts the owners; and the owner's setting agentAccount "off"
 * (set_app_config, read live) starts every agent as before. A failure after the OK is caught too, since only an orchestrator
 * can reach set_app_config: AGENT_BREAKER.failures agents started through the socket that failed (exited before any
 * result, or ended a turn in an error) within AGENT_BREAKER.windowMs, with none that succeeded since, switch the socket off
 * until the portal's next start, and the owners are alerted (agentRunEnded).
 */

/** The variable fff-portal.service sets to fff-agent.socket's path: none elsewhere (Windows, Macs, dev), so agents start as before. */
export const AGENT_SOCKET_VAR = 'FFF_AGENT_SOCKET';

/** How long the launcher has to answer OK before the agent starts as the portal's account instead. */
export const AGENT_ANSWER_MS = 30_000;

/** How often the same failure alerts the owners (the log says it every time). */
export const AGENT_ALERT_EVERY_MS = 6 * 3_600_000;

type Alert = (title: string, body: string) => void;

/** The breaker: this many failed agents through the socket within the window, none succeeding since, switch it off until a restart. */
export const AGENT_BREAKER = { failures: 2, windowMs: 30 * 60_000 };

const state: { setting: () => 'on' | 'off' | undefined; alert: Alert; lastAlert: Map<string, number>; failures: number[]; tripped?: string } = {
  setting: () => undefined,
  alert: () => {},
  lastAlert: new Map(),
  failures: [],
};

/** The server's start: where the setting is read (live) and how the owners are alerted (notifier.host). */
export function configureAgentAccount(o: { setting: () => 'on' | 'off' | undefined; alert: Alert }): void {
  state.setting = o.setting;
  state.alert = o.alert;
  state.failures = [];
  state.tripped = undefined;
  state.lastAlert.clear();
}

/** Why the breaker switched the socket off for this run of the portal, or undefined. */
export const agentAccountTripped = (): string | undefined => state.tripped;

/**
 * An agent started through the socket ended a turn well (ok) or failed (exited before any result, or a turn's result was
 * an error). The breaker trips at AGENT_BREAKER.failures failures within the window with no success since.
 */
export function agentRunEnded(ok: boolean, why: string, now = Date.now()): void {
  if (ok) return void (state.failures = []);
  state.failures = [...state.failures.filter((t) => now - t < AGENT_BREAKER.windowMs), now];
  console.warn(`agent account: an agent started as fff-agent failed (${state.failures.length} of ${AGENT_BREAKER.failures} before the breaker): ${why}`);
  if (state.tripped || state.failures.length < AGENT_BREAKER.failures) return;
  state.tripped = why;
  console.warn(`agent account: the breaker tripped: agents start as the portal's account until the portal's next start`);
  state.alert(
    'Agents switched back to the portal\'s account',
    `${AGENT_BREAKER.failures} agents started as their own account (fff-agent, w5598) failed within ${AGENT_BREAKER.windowMs / 60_000} min, the last: ${why}. Until the portal's next start every agent starts as before, as the portal's account, so orchestrators and the dispatcher keep working. journalctl -u 'fff-agent@*' says why; agentAccount "off" (set_app_config) keeps it off after a restart (docs/vault.md, "In the VM").`,
  );
}

/**
 * Watches an agent's output through the socket for its turns' results: the head of each line is enough (stream-json puts
 * "type" and "is_error" first), so a long line costs nothing.
 */
export function resultWatcher(onResult: (ok: boolean) => void): (chunk: Buffer) => void {
  let head = '';
  let full = false;
  return (chunk: Buffer) => {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(10, from);
      const part = chunk.subarray(from, nl < 0 ? chunk.length : nl);
      if (!full) {
        head += part.subarray(0, 256 - head.length).toString('utf8');
        full = head.length >= 256;
      }
      if (nl < 0) return;
      // A turn's own limits (max turns, max budget) are not the account's failures.
      if (head.startsWith('{"type":"result"')) onResult(!/"is_error":true|"subtype":"error/.test(head) || /"subtype":"error_max_/.test(head));
      head = '';
      full = false;
      from = nl + 1;
    }
  };
}

/** A failure: logged every time, sent to the owners once per AGENT_ALERT_EVERY_MS for each reason. */
export function agentAccountFellBack(why: string, now = Date.now()): void {
  console.warn(`agent account: started an agent as the portal's account instead (the fallback): ${why}`);
  const key = why.replace(/\d+/g, '#');
  if (now - (state.lastAlert.get(key) ?? -Infinity) < AGENT_ALERT_EVERY_MS) return;
  state.lastAlert.set(key, now);
  state.alert(
    'Agents run as the portal\'s account',
    `The portal could not start an agent as its own account (fff-agent, w5598), so it started it as before, as the portal's account: ${why}. Work goes on; the GH_TOKEN of the portal's git and gh is fenced from that agent only by its read guard meanwhile. fffctl logs and journalctl -u 'fff-agent@*' say more; agentAccount "off" (set_app_config) stops the attempts (docs/vault.md, "In the VM").`,
  );
}

/** The header fff-agent-launch reads: the ops worker's (args, Claude Code's settings, the credential), the folder and Claude Code's own folder. */
export function agentHeader(o: Pick<SpawnOptions, 'args' | 'env' | 'cwd'>, version: string, configDir: string): string {
  const h = JSON.parse(opsHeader(o, version)) as Record<string, unknown>;
  return `${JSON.stringify({ ...h, cwd: o.cwd ?? process.cwd(), configDir })}\n`;
}

/** Claude Code's folder the portal's agents use (the portal's own, which it reads their transcripts from). */
export const agentConfigDir = (env: NodeJS.ProcessEnv = process.env): string => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');

const INTERRUPT = (id: string) => `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } })}\n`;

/**
 * Options.spawnClaudeCodeProcess through fff-agent.socket, falling back to `fallback` (the portal's own account) on any
 * failure before the launcher's OK. What the SDK writes meanwhile waits and goes to whichever process runs.
 */
export function agentSpawner(
  socketPath: string,
  o2: { version?: string; configDir?: string; connect?: (p: string) => net.Socket; fallback?: (o: SpawnOptions) => SpawnedProcess; fellBack?: (why: string) => void; ran?: (ok: boolean, why: string) => void; answerMs?: number } = {},
) {
  const version = o2.version ?? sdkVersion();
  const configDir = o2.configDir ?? agentConfigDir();
  const connect = o2.connect ?? ((p: string) => net.createConnection({ path: p, allowHalfOpen: true }));
  const fallback = o2.fallback ?? tokenPipeSpawner();
  const fellBack = o2.fellBack ?? agentAccountFellBack;
  const answerMs = o2.answerMs ?? AGENT_ANSWER_MS;
  const ran = o2.ran ?? agentRunEnded;
  return (o: SpawnOptions): SpawnedProcess => {
    const ev = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let killed = false;
    let done = false;
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    let sock: net.Socket | undefined;
    let child: SpawnedProcess | undefined;
    let acked = false;
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, err?: Error) => {
      if (done) return;
      done = true;
      exitCode = err ? 1 : code;
      signalCode = signal;
      stdout.end();
      if (err) ev.emit('error', err);
      ev.emit('exit', err ? null : code, signal);
    };
    // The portal's own account, as before w5598: the same process the SDK would have had without this spawner.
    const startHere = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sock && !sock.destroyed) sock.destroy();
      if (killed) return;
      fellBack(why);
      let c: SpawnedProcess;
      try {
        c = fallback(o);
      } catch (e) {
        return finish(1, null, e as Error);
      }
      child = c;
      c.stdout.pipe(stdout, { end: false });
      stdin.pipe(c.stdin);
      c.on('error', (e: Error) => finish(1, null, e));
      c.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        // Its last output first: the SDK reads a result it wrote just before it exited.
        if (c.stdout.readableEnded) finish(code, signal);
        else c.stdout.once('end', () => finish(code, signal));
      });
    };
    const timer = setTimeout(() => startHere(`fff-agent-launch did not answer within ${Math.round(answerMs / 1000)} s`), answerMs);
    timer.unref?.();
    const s = connect(socketPath);
    sock = s;
    let head = Buffer.alloc(0);
    let failed: string | undefined;
    let results = 0;
    const watch = resultWatcher((ok) => {
      results++;
      ran(ok, 'a turn ended in an error');
    });
    s.on('data', (chunk: Buffer) => {
      if (settled && !acked) return;
      if (killed || done) return;
      if (acked) {
        watch(chunk);
        return void stdout.write(chunk);
      }
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(10);
      if (nl < 0) {
        if (head.length > 4096) startHere('fff-agent-launch answered something other than OK');
        return;
      }
      const line = head.subarray(0, nl).toString('utf8').trim();
      const rest = head.subarray(nl + 1);
      head = Buffer.alloc(0);
      if (line !== 'OK') return startHere(`fff-agent-launch refused: ${line.replace(/^ERR\s*/, '') || 'no answer'}`);
      settled = true;
      acked = true;
      clearTimeout(timer);
      if (rest.length) {
        watch(rest);
        stdout.write(rest);
      }
      stdin.pipe(s, { end: false });
      stdin.on('end', () => hangUp());
    });
    s.on('error', (e: NodeJS.ErrnoException) => {
      failed =
        e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
          ? `no ${socketPath} (fff-agent.socket is not running: install.sh's agent account step failed or has not run, fffctl logs)`
          : e.code === 'EACCES'
            ? `${socketPath}: the portal's account may not connect (fff-agent.socket's owner)`
            : `${socketPath}: ${e.message}`;
    });
    s.on('end', () => s.destroy());
    s.on('close', () => {
      if (!acked) return startHere(failed ?? 'fff-agent.socket closed the connection without an answer (journalctl -u \'fff-agent@*\')');
      // Ended with no result and not by a stop: a failure the launcher's OK could not catch (the breaker counts it).
      if (!killed && !results) ran(false, 'its Claude Code ended before any result (journalctl -u \'fff-agent@*\')');
      finish(killed ? null : 0, killed ? 'SIGTERM' : null);
    });
    s.write(agentHeader(o, version, configDir));
    // A stop through the socket: Claude Code is told to end its turn, then its input ends, so it exits; the socket closes then.
    const hangUp = () => {
      if (s.writableEnded || s.destroyed) return;
      stdin.unpipe(s);
      s.end(INTERRUPT(`agent-stop-${Date.now()}`));
      const t = setTimeout(() => s.destroy(), 60_000);
      t.unref?.();
      s.once('close', () => clearTimeout(t));
    };
    const stop = (signal: NodeJS.Signals) => {
      if (killed) return;
      killed = true;
      if (child) return void child.kill(signal);
      finish(null, signal);
      clearTimeout(timer);
      if (acked) hangUp();
      else s.destroy();
    };
    o.signal?.addEventListener('abort', () => stop('SIGTERM'));
    return {
      stdin,
      stdout,
      get killed() {
        return killed;
      },
      get exitCode() {
        return child ? child.exitCode : exitCode;
      },
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        stop(signal);
        return true;
      },
      on: (e: string, l: (...a: unknown[]) => void) => void ev.on(e, l),
      once: (e: string, l: (...a: unknown[]) => void) => void ev.once(e, l),
      off: (e: string, l: (...a: unknown[]) => void) => void ev.off(e, l),
      get signalCode() {
        return signalCode;
      },
    } as unknown as SpawnedProcess;
  };
}

/**
 * Options for the claude of an agent the portal starts on its own computer (orchestrators, the dispatcher, the bug-thread
 * judge): through fff-agent.socket where the VM's unit names it and agentAccount is not "off", else as before w5598 (the
 * token on a pipe, tokenPipeSpawner; nothing on Windows). Read at each start, so the setting takes effect at the next one.
 */
export function agentProcessOptions(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { spawnClaudeCodeProcess?: (o: SpawnOptions) => SpawnedProcess } {
  if (platform === 'win32') return {};
  const socket = env[AGENT_SOCKET_VAR];
  if (!socket || state.setting() === 'off' || state.tripped) return { spawnClaudeCodeProcess: tokenPipeSpawner() };
  return { spawnClaudeCodeProcess: agentSpawner(socket, { configDir: agentConfigDir(env) }) };
}
