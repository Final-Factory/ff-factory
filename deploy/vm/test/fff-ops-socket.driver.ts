/**
 * The portal's side of fff-ops-socket.test.sh (w638): the real opsSpawner against the real fff-ops.socket settings under
 * systemd, with the real fff-ops-launch and a fake claude. Run as the account the socket belongs to.
 *   node deploy/vm/test/fff-ops-socket.driver.ts <socket> <sdk version>
 * 1. The mechanism: while one connection is open, systemd drops a second one without a word (MaxConnections=1).
 * 2. What a fresh job does: stop the process (the SDK's own stop: stdin ends, then kill) and start the next at once,
 *    with the last one idle and mid-turn. The next one must get the launcher's OK and run.
 */
import net from 'node:net';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { opsHeader, opsSpawner } from '../../../server/opsWorker.ts';

const [sock, version] = process.argv.slice(2);
if (!sock || !version) throw new Error('usage: fff-ops-socket.driver.ts <socket> <sdk version>');
const opts = { command: 'claude', args: ['--input-format', 'stream-json'], env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-ci' }, signal: new AbortController().signal } as unknown as SpawnOptions;
const fail = (why: string): never => {
  console.log(`FAIL: ${why}`);
  process.exit(1);
};

/** Resolves with the first stdout line that matches, or fails after `ms` (with the process's error, if it had one). */
function line(p: SpawnedProcess, re: RegExp, what: string, ms = 30_000): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    let err = '';
    const t = setTimeout(() => fail(`${what}: nothing within ${ms} ms${err ? ` (${err})` : ''}`), ms);
    p.on('error', (e: Error) => (err = e.message));
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const hit = buf.split('\n').find((l) => re.test(l));
      if (hit) {
        clearTimeout(t);
        resolve(hit);
      }
    });
    p.on('exit', () => !buf.split('\n').some((l) => re.test(l)) && setTimeout(() => fail(`${what}: it exited first${err ? `: ${err}` : ''}`), 50));
  });
}

// 1. The mechanism, with raw connections.
const raw = () => net.createConnection({ path: sock, allowHalfOpen: true });
const first = raw();
first.write(opsHeader(opts, version));
await new Promise<void>((resolve) => {
  let got = '';
  first.on('data', (d) => (got += d.toString()) && /^OK\n.*"hello"/s.test(got) && resolve());
  setTimeout(() => fail(`the first connection got no OK and hello: ${JSON.stringify(got)}`), 20_000);
});
const second = raw();
second.write(opsHeader(opts, version));
const dropped = await new Promise<string>((resolve) => {
  let got = '';
  second.on('data', (d) => (got += d.toString()));
  second.on('error', () => {});
  second.on('close', () => resolve(got));
  setTimeout(() => resolve('STILL OPEN'), 5_000);
});
if (dropped !== '') fail(`a second connection while one was open was not dropped: ${JSON.stringify(dropped)}`);
console.log('mechanism: a second connection while one is open is dropped without a word (MaxConnections=1)');
first.end();
await new Promise((r) => first.on('close', r));

// 2. A fresh job: the SDK's stop of the last process, then the next one at once.
const spawn = opsSpawner(sock, version);
const stop = (p: SpawnedProcess) => {
  p.stdin.end();
  p.kill('SIGTERM');
};
let p = spawn(opts);
await line(p, /"hello"/, 'the first process');
for (const state of ['idle', 'idle', 'mid-turn', 'idle', 'mid-turn']) {
  if (state === 'mid-turn') {
    p.stdin.write('{"type":"user","message":{"role":"user","content":"slow"}}\n');
    await line(p, /"busy"/, 'the turn');
  }
  const at = Date.now();
  stop(p);
  p = spawn(opts);
  const hello = await line(p, /"hello"/, `a new process after a stop (the last one ${state})`);
  console.log(`after a stop (the last one ${state}): the next process runs (${hello}) after ${Date.now() - at} ms`);
}
stop(p);
console.log('PASS');
process.exit(0);
