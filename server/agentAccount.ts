import { EventEmitter } from 'node:events';
import fs from 'node:fs';
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
 * all work; the lockout review, w5651):
 * - It ships warn-only: the mode is "off", "warn" or "on" (agentAccountMode), and unset is "warn": every agent starts as
 *   before, as fff, and the socket is only probed with a `claude --version` on a dummy credential (agentProbe), logged
 *   ("agent account (warn): ...") and alerted when it fails. An owner turns it "on" once that has been seen working.
 * - Two switches set the mode, read at each agent's start: the switch file FFF_AGENT_SWITCH (/etc/fff/agent-account,
 *   `fffctl agents off|warn|on|default`, which the ops worker may run with no orchestrator) wins over the owner's setting
 *   agentAccount (set_app_config).
 * - With "on", any failure before the launcher's "OK" (no socket, a refused connection, its "ERR <why>", no answer) starts
 *   that agent as before (tokenPipeSpawner, as fff) and alerts the owners; so does a Claude Code that answered OK and then
 *   writes nothing for AGENT_FIRST_OUTPUT_MS after its input (a stall: what the SDK wrote is replayed to the new process).
 * - Failures after the OK trip a breaker: AGENT_BREAKER.failures agents started through the socket that failed (stalled,
 *   exited before any result, or ended a turn in an error) within AGENT_BREAKER.windowMs, with none that succeeded since,
 *   switch the socket off until the portal's next start, and the owners are alerted (agentRunEnded).
 */

/** The variable fff-portal.service sets to fff-agent.socket's path: none elsewhere (Windows, Macs, dev), so agents start as before. */
export const AGENT_SOCKET_VAR = 'FFF_AGENT_SOCKET';

/** How long the launcher has to answer OK before the agent starts as the portal's account instead. */
export const AGENT_ANSWER_MS = 30_000;

/** The variable fff-portal.service sets to the switch file (`fffctl agents`): "off", "warn" or "on", winning over agentAccount. */
export const AGENT_SWITCH_VAR = 'FFF_AGENT_SWITCH';

/** After the launcher's OK, how long Claude Code may write nothing once the SDK has written to it before it counts as stalled. */
export const AGENT_FIRST_OUTPUT_MS = 3 * 60_000;

/** In "warn", how often the socket is probed (at an agent's start, at most this often). */
export const AGENT_PROBE_EVERY_MS = 30 * 60_000;

/** The probe's credential: never a real one (the launcher wants one, `claude --version` reads none). */
export const AGENT_PROBE_TOKEN = 'sk-ant-oat01-fff-agent-probe-not-a-token';

export type AgentAccountMode = 'off' | 'warn' | 'on';

/** How often the same failure alerts the owners (the log says it every time). */
export const AGENT_ALERT_EVERY_MS = 6 * 3_600_000;

type Alert = (title: string, body: string) => void;

/** The breaker: this many failed agents through the socket within the window, none succeeding since, switch it off until a restart. */
export const AGENT_BREAKER = { failures: 2, windowMs: 30 * 60_000 };

const state: {
  setting: () => AgentAccountMode | undefined;
  alert: Alert;
  lastAlert: Map<string, number>;
  failures: number[];
  tripped?: string;
  lastProbe: number;
  probe?: typeof agentProbe;
} = {
  setting: () => undefined,
  alert: () => {},
  lastAlert: new Map(),
  failures: [],
  lastProbe: -Infinity,
};

/** The server's start: where the setting is read (live) and how the owners are alerted (notifier.host); probe is for tests. */
export function configureAgentAccount(o: { setting: () => AgentAccountMode | undefined; alert: Alert; probe?: typeof agentProbe }): void {
  state.setting = o.setting;
  state.alert = o.alert;
  state.failures = [];
  state.tripped = undefined;
  state.lastAlert.clear();
  state.lastProbe = -Infinity;
  state.probe = o.probe;
}

const isMode = (v: unknown): v is AgentAccountMode => v === 'off' || v === 'warn' || v === 'on';

/** The switch file's mode, or undefined when there is none (or it says something else, which the log names). */
export function agentSwitchFile(file: string | undefined): AgentAccountMode | undefined {
  if (!file) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (isMode(text)) return text;
  console.warn(`agent account: ${file} says "${text.slice(0, 40)}", not off, warn or on (fffctl agents): the setting decides`);
  return undefined;
}

/** The mode now: the switch file (fffctl agents) first, then the owner's setting agentAccount, else "warn". */
export const agentAccountMode = (env: NodeJS.ProcessEnv = process.env): AgentAccountMode =>
  agentSwitchFile(env[AGENT_SWITCH_VAR]) ?? state.setting() ?? 'warn';

/** Alerts the owners once per AGENT_ALERT_EVERY_MS for each reason (numbers aside). */
function alertOnce(why: string, title: string, body: string, now: number): void {
  const key = `${title}|${why.replace(/\d+/g, '#')}`;
  if (now - (state.lastAlert.get(key) ?? -Infinity) < AGENT_ALERT_EVERY_MS) return;
  state.lastAlert.set(key, now);
  state.alert(title, body);
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
    `${AGENT_BREAKER.failures} agents started as their own account (fff-agent, w5598) failed within ${AGENT_BREAKER.windowMs / 60_000} min, the last: ${why}. Until the portal's next start every agent starts as before, as the portal's account, so orchestrators and the dispatcher keep working. journalctl -u 'fff-agent@*' says why; fffctl agents off (the ops worker may run it) or agentAccount "off" (set_app_config) keeps it off after a restart (docs/vault.md, "In the VM").`,
  );
}

/** A line longer than this is no result (a result is a few kB); it is skipped, not kept. */
const RESULT_LINE_MAX = 4 * 1024 * 1024;

/**
 * Watches an agent's output through the socket for its turns' results: each line whose top-level "type" is "result",
 * wherever in the line that key falls.
 */
export function resultWatcher(onResult: (ok: boolean) => void): (chunk: Buffer) => void {
  // The whole line, parsed: Claude Code 0.3.323 writes a result's "type" after its usage, not first (the w5598 e2e).
  let line: Buffer[] = [];
  let size = 0;
  return (chunk: Buffer) => {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(10, from);
      const part = chunk.subarray(from, nl < 0 ? chunk.length : nl);
      if (size <= RESULT_LINE_MAX) line.push(part);
      size += part.length;
      if (nl < 0) return;
      const text = size <= RESULT_LINE_MAX ? Buffer.concat(line).toString('utf8') : '';
      if (text.includes('"result"')) {
        let m: { type?: unknown; subtype?: unknown; is_error?: unknown } | undefined;
        try {
          m = JSON.parse(text);
        } catch {
          m = undefined;
        }
        const sub = typeof m?.subtype === 'string' ? m.subtype : '';
        // A turn's own limits (max turns, max budget) are not the account's failures.
        if (m?.type === 'result') onResult((m.is_error !== true && !sub.startsWith('error')) || sub.startsWith('error_max_'));
      }
      line = [];
      size = 0;
      from = nl + 1;
    }
  };
}

/** A failure: logged every time, sent to the owners once per AGENT_ALERT_EVERY_MS for each reason. */
export function agentAccountFellBack(why: string, now = Date.now()): void {
  console.warn(`agent account: started an agent as the portal's account instead (the fallback): ${why}`);
  alertOnce(
    why,
    'Agents run as the portal\'s account',
    `The portal could not start an agent as its own account (fff-agent, w5598), so it started it as before, as the portal's account: ${why}. Work goes on; the GH_TOKEN of the portal's git and gh is fenced from that agent only by its read guard meanwhile. fffctl agents status and journalctl -u 'fff-agent@*' say more; fffctl agents off (the ops worker may run it) or agentAccount "off" (set_app_config) stops the attempts (docs/vault.md, "In the VM").`,
    now,
  );
}

/**
 * The warn mode's check: one connection to the socket asking for `claude --version` on a dummy credential, as an agent's
 * start would (the header, the launcher, fff-agent@.service, its views, Claude Code as fff-agent). Resolves, never rejects.
 */
export function agentProbe(
  socketPath: string,
  o: { version?: string; configDir?: string; cwd?: string; connect?: (p: string) => net.Socket; timeoutMs?: number } = {},
): Promise<{ ok: boolean; why: string }> {
  const connect = o.connect ?? ((p: string) => net.createConnection({ path: p, allowHalfOpen: true }));
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let err: string | undefined;
    let over = false;
    const end = (ok: boolean, why: string) => {
      if (over) return;
      over = true;
      clearTimeout(t);
      if (!s.destroyed) s.destroy();
      resolve({ ok, why });
    };
    const s = connect(socketPath);
    const t = setTimeout(() => end(false, `no answer within ${Math.round((o.timeoutMs ?? 60_000) / 1000)} s`), o.timeoutMs ?? 60_000);
    t.unref?.();
    s.on('data', (c: Buffer) => {
      if (out.length < 4096) out = Buffer.concat([out, c]);
    });
    s.on('error', (e: NodeJS.ErrnoException) => void (err = e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? `no ${socketPath} (fff-agent.socket is not running)` : `${socketPath}: ${e.message}`));
    s.on('end', () => s.destroy());
    s.on('close', () => {
      const lines = out.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return end(false, err ?? 'the socket closed without an answer (journalctl -u \'fff-agent@*\')');
      if (lines[0] !== 'OK') return end(false, `fff-agent-launch refused: ${lines[0].replace(/^ERR\s*/, '').slice(0, 200)}`);
      const v = lines.slice(1).find((l) => /\d+\.\d+\.\d+/.test(l));
      end(Boolean(v), v ? `the launcher answered OK and Claude Code ${v.slice(0, 80)} ran as fff-agent` : 'the launcher answered OK, then Claude Code printed no version');
    });
    // In the portal's own folder (/srv/fff/app/... in the VM), never the process's working folder: from another one (the
    // e2e's ssh session in /home/fffadmin) the launcher refused the folder and warn alerted a failure that was not one.
    const cwd = o.cwd ?? path.resolve(import.meta.dirname, '..');
    s.write(agentHeader({ args: ['--version'], env: { CLAUDE_CODE_OAUTH_TOKEN: AGENT_PROBE_TOKEN }, cwd }, o.version ?? sdkVersion(), o.configDir ?? agentConfigDir()));
  });
}

/** In "warn": the probe in the background, at most once per AGENT_PROBE_EVERY_MS, its result logged and a failure alerted. */
function warnProbe(socketPath: string, env: NodeJS.ProcessEnv, now = Date.now()): void {
  if (now - state.lastProbe < AGENT_PROBE_EVERY_MS) return;
  state.lastProbe = now;
  void (state.probe ?? agentProbe)(socketPath, { configDir: agentConfigDir(env) }).then(({ ok, why }) => {
    console.log(`agent account (warn): ${ok ? 'the check passed' : 'the check failed'}: ${why}; this agent starts as the portal's account, as in "warn" every agent does`);
    if (!ok)
      alertOnce(
        why,
        'The agent account check failed',
        `The portal's agents still start as the portal's account ("warn", w5598), and its check of starting them as their own (fff-agent) failed: ${why}. Nothing stops; fix it before an owner turns it on (fffctl agents status, journalctl -u 'fff-agent@*', docs/vault.md "In the VM").`,
        Date.now(),
      );
  });
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
  o2: { version?: string; configDir?: string; connect?: (p: string) => net.Socket; fallback?: (o: SpawnOptions) => SpawnedProcess; fellBack?: (why: string) => void; ran?: (ok: boolean, why: string) => void; answerMs?: number; firstOutputMs?: number } = {},
) {
  const version = o2.version ?? sdkVersion();
  const configDir = o2.configDir ?? agentConfigDir();
  const connect = o2.connect ?? ((p: string) => net.createConnection({ path: p, allowHalfOpen: true }));
  const fallback = o2.fallback ?? tokenPipeSpawner();
  const fellBack = o2.fellBack ?? agentAccountFellBack;
  const answerMs = o2.answerMs ?? AGENT_ANSWER_MS;
  const ran = o2.ran ?? agentRunEnded;
  const firstOutputMs = o2.firstOutputMs ?? AGENT_FIRST_OUTPUT_MS;
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
    // After the OK: what the SDK wrote until Claude Code's first output (replayed if it stalls), and the stall's timer.
    let sent: Buffer[] | undefined = [];
    let stall: NodeJS.Timeout | undefined;
    let stalled = false;
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
    const runHere = (why: string, replay: Buffer[] = []) => {
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
      for (const b of replay) c.stdin.write(b);
      stdin.pipe(c.stdin);
      c.on('error', (e: Error) => finish(1, null, e));
      c.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        // Its last output first: the SDK reads a result it wrote just before it exited.
        if (c.stdout.readableEnded) finish(code, signal);
        else c.stdout.once('end', () => finish(code, signal));
      });
    };
    const startHere = (why: string) => {
      if (settled) return;
      settled = true;
      runHere(why);
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
      if ((settled && !acked) || stalled) return;
      if (killed || done) return;
      if (acked) {
        sent = undefined;
        clearTimeout(stall);
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
        sent = undefined;
        watch(rest);
        stdout.write(rest);
      }
      stdin.on('data', tap);
      stdin.pipe(s, { end: false });
      stdin.on('end', () => hangUp());
    });
    // Until Claude Code's first output, a copy of its input, and a stall once it has had input and said nothing.
    const tap = (b: Buffer) => {
      if (!sent) return void stdin.off('data', tap);
      sent.push(b);
      stall ??= setTimeout(() => {
        if (!sent || killed || done) return;
        stalled = true;
        stdin.off('data', tap);
        stdin.unpipe(s);
        const replay = sent;
        sent = undefined;
        const why = `its Claude Code wrote nothing for ${Math.round(firstOutputMs / 1000)} s after its input (a stall after fff-agent-launch's OK)`;
        ran(false, why);
        runHere(why, replay);
      }, firstOutputMs);
      stall.unref?.();
    };
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
      clearTimeout(stall);
      if (stalled) return;
      if (!acked) return startHere(failed ?? 'fff-agent.socket closed the connection without an answer (journalctl -u \'fff-agent@*\')');
      // Ended with no result and not by a stop: a failure the launcher's OK could not catch (the breaker counts it).
      if (!killed && !results) ran(false, 'its Claude Code ended before any result (journalctl -u \'fff-agent@*\')');
      // An end with no result is a failure to the SDK as well (it hears no exit code through the socket).
      finish(killed ? null : results ? 0 : 1, killed ? 'SIGTERM' : null);
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
      clearTimeout(stall);
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
 * judge): through fff-agent.socket where the VM's unit names it and the mode is "on" (the breaker not tripped), else as
 * before w5598 (the token on a pipe, tokenPipeSpawner; nothing on Windows), with the socket probed in "warn". Read at each
 * start, so a switch takes effect at the next one.
 */
export function agentProcessOptions(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { spawnClaudeCodeProcess?: (o: SpawnOptions) => SpawnedProcess } {
  if (platform === 'win32') return {};
  const socket = env[AGENT_SOCKET_VAR];
  const mode = socket ? agentAccountMode(env) : 'off';
  if (socket && mode === 'warn') warnProbe(socket, env);
  if (!socket || mode !== 'on' || state.tripped) return { spawnClaudeCodeProcess: tokenPipeSpawner() };
  return { spawnClaudeCodeProcess: agentSpawner(socket, { configDir: agentConfigDir(env) }) };
}
