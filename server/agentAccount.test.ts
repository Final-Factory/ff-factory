import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_BREAKER, AGENT_SOCKET_VAR, agentAccountFellBack, agentAccountTripped, agentRunEnded, resultWatcher, agentHeader, agentProcessOptions, agentSpawner, configureAgentAccount } from './agentAccount.ts';
import { tokenPipeSpawner } from './tokenPipe.ts';

/**
 * w5598: the portal VM's agents start as their own account through fff-agent.socket, and never fail to start because of
 * it (lothsahn: the owners are away, a portal whose orchestrators or dispatcher cannot start stops all work): any failure
 * before the launcher's OK starts the agent as before and alerts; the setting agentAccount "off" skips the socket.
 */

const tok = ['sk', 'ant', 'oat01', 'y'.repeat(40)].join('-');
const opts = (cwd = os.tmpdir()): SpawnOptions =>
  ({ command: '/bin/sh', args: ['-c', 'echo "{\\"here\\":$$}"; cat'], cwd, env: { CLAUDE_CODE_OAUTH_TOKEN: tok, HOME: '/h', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, signal: new AbortController().signal }) as SpawnOptions;

function sockPath(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5598-'));
  return { dir, file: path.join(dir, 'claude.sock') };
}

/** A stand-in fff-agent-launch: reads the header, answers `answer`, then (on OK) echoes each line back as JSON. */
function launcher(file: string, answer: string | undefined, seen: { header?: Record<string, unknown> }): Promise<net.Server> {
  const srv = net.createServer({ allowHalfOpen: true }, (c) => {
    let buf = '';
    let started = false;
    c.on('data', (d) => {
      buf += d.toString();
      if (!started) {
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        seen.header = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        started = true;
        if (answer === undefined) return void c.destroy();
        c.write(`${answer}\n`);
        if (answer !== 'OK') return void c.end();
        c.write('{"via":"socket"}\n');
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        c.write(`${JSON.stringify({ echo: line.includes('interrupt') ? 'interrupt' : line })}\n`);
      }
    });
    c.on('end', () => c.end());
  });
  return new Promise((r) => srv.listen(file, () => r(srv)));
}

/** Reads the process's stdout until `n` lines arrived, or it ended. */
function lines(p: SpawnedProcess, n: number): Promise<string[]> {
  return new Promise((resolve) => {
    const out: string[] = [];
    let buf = '';
    const done = () => resolve(out);
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        out.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (out.length >= n) return done();
      }
    });
    p.stdout.on('end', done);
  });
}

const exited = (p: SpawnedProcess) => new Promise<unknown[]>((r) => p.once('exit', (...a: unknown[]) => r(a)));

test('w5598: the header carries the folder, Claude Code\'s folder and the token for the launcher, nothing of the portal\'s', () => {
  const h = JSON.parse(agentHeader({ args: ['/x/cli.js', '--output-format', 'stream-json'], env: { CLAUDE_CODE_OAUTH_TOKEN: tok, HOME: '/h', GH_TOKEN: 'g', CLAUDE_CONFIG_DIR: '/c' }, cwd: '/srv/fff/base' }, '1.2.3', '/srv/fff/home/.claude'));
  assert.deepEqual(h.args, ['--output-format', 'stream-json']);
  assert.equal(h.cwd, '/srv/fff/base');
  assert.equal(h.configDir, '/srv/fff/home/.claude');
  assert.equal(h.sdkVersion, '1.2.3');
  assert.deepEqual(Object.keys(h.env), ['CLAUDE_CODE_OAUTH_TOKEN']);
});

test('w5598: through the socket on OK: the agent\'s input and output flow over it, a stop interrupts and ends it', async () => {
  const { dir, file } = sockPath();
  const seen: { header?: Record<string, unknown> } = {};
  const srv = await launcher(file, 'OK', seen);
  const fell: string[] = [];
  try {
    const ran: boolean[] = [];
    const p = agentSpawner(file, { version: '9', configDir: '/cfg', fallback: () => assert.fail('no fallback on OK'), fellBack: (w) => fell.push(w), ran: (ok) => ran.push(ok) })(opts('/srv/fff/base'));
    p.stdin.write('{"type":"user"}\n');
    const got = await lines(p, 2);
    assert.deepEqual(got.map((l) => JSON.parse(l)), [{ via: 'socket' }, { echo: '{"type":"user"}' }]);
    assert.equal(seen.header?.cwd, '/srv/fff/base');
    assert.equal(seen.header?.configDir, '/cfg');
    const ex = exited(p);
    p.kill('SIGTERM');
    assert.deepEqual(await ex, [null, 'SIGTERM']);
    assert.deepEqual(fell, []);
    assert.deepEqual(ran, [], 'a stop is no failure');
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, answer, want] of [
  ['no socket', null, /no .*claude\.sock \(fff-agent\.socket is not running/],
  ['the launcher\'s ERR', 'ERR cannot enter /srv/fff/base', /refused: cannot enter \/srv\/fff\/base/],
  ['a connection closed without a word', undefined, /closed the connection without an answer/],
] as const) {
  test(`w5598: the fallback: ${name} starts the agent as the portal's account, with its token on a pipe, and alerts`, async () => {
    const { dir, file } = sockPath();
    const srv = answer === null ? undefined : await launcher(file, answer, {});
    const fell: string[] = [];
    try {
      const p = agentSpawner(file, { version: '9', fallback: tokenPipeSpawner(spawn), fellBack: (w) => fell.push(w) })(opts());
      // Written before the fallback started: it waits and reaches the process that runs.
      p.stdin.write('hello\n');
      const got = await lines(p, 2);
      assert.match(got[0], /^\{"here":\d+\}$/);
      assert.equal(got[1], 'hello');
      assert.equal(fell.length, 1);
      assert.match(fell[0], want);
      assert.doesNotMatch(fell[0], new RegExp(tok));
      const ex = exited(p);
      p.stdin.end();
      assert.deepEqual(await ex, [0, null]);
    } finally {
      srv?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('w5598: the fallback: a launcher that never answers is given up after answerMs', async () => {
  const { dir, file } = sockPath();
  const srv = net.createServer(() => {});
  await new Promise<void>((r) => srv.listen(file, () => r()));
  const fell: string[] = [];
  try {
    const p = agentSpawner(file, { version: '9', answerMs: 200, fallback: tokenPipeSpawner(spawn), fellBack: (w) => fell.push(w) })(opts());
    const got = await lines(p, 1);
    assert.match(got[0], /^\{"here":\d+\}$/);
    assert.match(fell[0], /did not answer within 0 s/);
    const ex = exited(p);
    p.kill('SIGTERM');
    await ex;
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w5598: agentProcessOptions: the socket only where the unit names it and the setting is not "off"', () => {
  configureAgentAccount({ setting: () => undefined, alert: () => {} });
  assert.deepEqual(agentProcessOptions({}, 'win32'), {});
  assert.equal(agentProcessOptions({}, 'linux').spawnClaudeCodeProcess?.name, tokenPipeSpawner().name);
  const on = agentProcessOptions({ [AGENT_SOCKET_VAR]: '/run/fff-agent/claude.sock' }, 'linux').spawnClaudeCodeProcess;
  assert.ok(on);
  configureAgentAccount({ setting: () => 'off', alert: () => {} });
  const off = agentProcessOptions({ [AGENT_SOCKET_VAR]: '/run/fff-agent/claude.sock' }, 'linux').spawnClaudeCodeProcess;
  assert.equal(off?.toString(), tokenPipeSpawner().toString());
  assert.notEqual(on.toString(), off?.toString());
  configureAgentAccount({ setting: () => undefined, alert: () => {} });
});

test('w5598: the setting "off" starts no connection: the agent runs as before', async () => {
  configureAgentAccount({ setting: () => 'off', alert: () => {} });
  try {
    const { spawnClaudeCodeProcess } = agentProcessOptions({ [AGENT_SOCKET_VAR]: '/nonexistent/claude.sock' }, 'linux');
    const p = spawnClaudeCodeProcess!(opts());
    const got = await lines(p, 1);
    assert.match(got[0], /^\{"here":\d+\}$/);
    const ex = exited(p);
    p.stdin.end();
    await ex;
  } finally {
    configureAgentAccount({ setting: () => undefined, alert: () => {} });
  }
});

test('w5598: a fallback alerts the owners once per reason within AGENT_ALERT_EVERY_MS, and logs every time', () => {
  const alerts: string[] = [];
  configureAgentAccount({ setting: () => undefined, alert: (t, b) => alerts.push(`${t}: ${b}`) });
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (m: string) => logged.push(m);
  try {
    agentAccountFellBack('no /run/fff-agent/claude.sock', 1_000);
    agentAccountFellBack('no /run/fff-agent/claude.sock', 2_000);
    agentAccountFellBack('fff-agent-launch refused: x', 3_000);
    agentAccountFellBack('no /run/fff-agent/claude.sock', 1_000 + 7 * 3_600_000);
  } finally {
    console.warn = warn;
    configureAgentAccount({ setting: () => undefined, alert: () => {} });
  }
  assert.equal(logged.length, 4);
  assert.equal(alerts.length, 3);
  assert.match(alerts[0], /as the portal's account/);
});

test('w5598: resultWatcher reads each turn\'s result from the head of its line, across chunks', () => {
  const got: boolean[] = [];
  const w = resultWatcher((ok) => got.push(ok));
  w(Buffer.from('{"type":"assistant","x":"' + 'z'.repeat(5000) + '"}\n{"type":"resu'));
  w(Buffer.from('lt","subtype":"success","is_error":false}\n{"type":"result","subtype":"error_during_execution","is_error":true}\n'));
  w(Buffer.from('{"type":"result","subtype":"error_max_turns","is_error":true}\n{"type":"system"}\n'));
  assert.deepEqual(got, [true, false, true]);
});

test('w5598: the breaker: two failed agents through the socket within the window, none succeeding since, start agents as before', () => {
  const alerts: string[] = [];
  configureAgentAccount({ setting: () => undefined, alert: (t) => alerts.push(t) });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const sock = { [AGENT_SOCKET_VAR]: '/run/fff-agent/claude.sock' };
    const viaSocket = () => agentProcessOptions(sock, 'linux').spawnClaudeCodeProcess!.toString() !== tokenPipeSpawner().toString();
    agentRunEnded(false, 'a', 0);
    agentRunEnded(true, '', 1_000);
    agentRunEnded(false, 'b', 2_000);
    assert.equal(agentAccountTripped(), undefined, 'a success between failures resets the count');
    agentRunEnded(false, 'c', 2_000 + AGENT_BREAKER.windowMs + 1);
    assert.equal(agentAccountTripped(), undefined, 'failures further apart than the window do not trip it');
    assert.ok(viaSocket());
    agentRunEnded(false, 'd', 2_000 + AGENT_BREAKER.windowMs + 2);
    assert.equal(agentAccountTripped(), 'd');
    assert.ok(!viaSocket());
    assert.deepEqual(alerts, ["Agents switched back to the portal's account"]);
  } finally {
    console.warn = warn;
    configureAgentAccount({ setting: () => undefined, alert: () => {} });
  }
});

test('w5598: an agent through the socket that ends before any result is a failure for the breaker; a stop is not', async () => {
  const { dir, file } = sockPath();
  const srv = net.createServer({ allowHalfOpen: true }, (c) => {
    c.once('data', () => {
      c.write('OK\n{"type":"system"}\n');
      setTimeout(() => c.end(), 20);
    });
  });
  await new Promise<void>((r) => srv.listen(file, () => r()));
  const ran: [boolean, string][] = [];
  try {
    const p = agentSpawner(file, { version: '9', fallback: () => assert.fail('no fallback after OK'), fellBack: () => {}, ran: (ok, why) => ran.push([ok, why]) })(opts());
    const ex = exited(p);
    await lines(p, 5);
    await ex;
    assert.equal(ran.length, 1);
    assert.equal(ran[0][0], false);
    assert.match(ran[0][1], /ended before any result/);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
