import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './proc.ts';
import { endSpawnThreadForTest, spawnThreadOn, useSpawnThread } from './spawnThread.ts';

const node = process.execPath;
const both = async <T>(f: () => Promise<T>): Promise<[T, T]> => {
  useSpawnThread(false);
  const off = await f();
  useSpawnThread(true, () => {});
  try {
    return [off, await f()];
  } finally {
    useSpawnThread(false);
  }
};

test('w6077: a program run from the spawn thread answers as execFile does: code, stdout, stderr', async () => {
  const [off, on] = await both(() => run(node, ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"]));
  assert.deepEqual(on, off);
  assert.equal(on.code, 3);
  assert.equal(on.stdout, 'out');
  assert.equal(on.stderr, 'err');
});

test('w6077: the environment and folder given reach the program', async () => {
  const [off, on] = await both(() => run(node, ['-e', 'process.stdout.write(process.env.W6077 + " " + process.cwd())'], { env: { ...process.env, W6077: 'yes' }, cwd: process.cwd() }));
  assert.deepEqual(on, off);
  assert.equal(on.stdout, `yes ${process.cwd()}`);
});

test('w6077: a program that cannot start answers code -1 with the reason, on the thread too', async () => {
  const [off, on] = await both(() => run('no-such-program-w6077', []));
  assert.equal(off.code, -1);
  assert.equal(on.code, -1);
  assert.match(on.stderr, /ENOENT/);
});

test('w6077: a timeout kills the program and says so, on the thread too', async () => {
  const [off, on] = await both(() => run(node, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 }));
  assert.equal(on.code, -1);
  assert.equal(on.timedOut, true);
  assert.equal(on.timedOut, off.timedOut);
  assert.equal(on.signal, off.signal);
});

test('w6077: aborting kills the program, with the same answer as execFile gives', async () => {
  const go = () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    return run(node, ['-e', 'setTimeout(() => {}, 20000)'], { signal: ac.signal });
  };
  const [off, on] = await both(go);
  assert.equal(on.code, -1);
  assert.equal(on.signal, off.signal);
  assert.equal(on.timedOut, off.timedOut);
  assert.equal(on.stderr, off.stderr);
});

test('w6077: a thread that ends answers its programs -1, and the next program gets a new thread', async () => {
  useSpawnThread(true, () => {});
  try {
    const slow = run(node, ['-e', 'setTimeout(() => {}, 3000)']);
    await new Promise((r) => setTimeout(r, 200));
    await endSpawnThreadForTest();
    const r = await slow;
    assert.equal(r.code, -1);
    assert.match(r.stderr, /spawn thread ended/);
    assert.equal(spawnThreadOn(), true);
    const next = await run(node, ['-e', "process.stdout.write('again')"]);
    assert.equal(next.code, 0);
    assert.equal(next.stdout, 'again');
  } finally {
    useSpawnThread(false);
  }
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('w6077: a thread that ends takes its running programs with it (no orphan left without its timeout)', async () => {
  useSpawnThread(true, () => {});
  try {
    const pidFile = `${process.env.TMPDIR ?? process.env.TEMP ?? '.'}/w6077-orphan-${process.pid}.txt`;
    const slow = run(node, ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 20000)`], { timeoutMs: 30_000 });
    const fs = await import('node:fs');
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    fs.rmSync(pidFile, { force: true });
    assert.ok(alive(pid), 'the program runs');
    await endSpawnThreadForTest();
    assert.equal((await slow).code, -1);
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid), false, 'the program ended with its thread');
  } finally {
    useSpawnThread(false);
  }
});

test('w6077: turning the thread off answers the programs still pending', async () => {
  useSpawnThread(true, () => {});
  const slow = run(node, ['-e', 'setTimeout(() => {}, 3000)']);
  await new Promise((r) => setTimeout(r, 200));
  useSpawnThread(false);
  const r = await slow;
  assert.equal(r.code, -1);
  assert.match(r.stderr, /turned off/);
});

test('w6077: a thread that keeps dying is given up: programs start on the calling thread again', async () => {
  const lines: string[] = [];
  useSpawnThread(true, (l) => lines.push(l));
  try {
    for (let i = 0; i < 3; i++) {
      const p = run(node, ['-e', 'setTimeout(() => {}, 3000)']);
      await new Promise((r) => setTimeout(r, 100));
      await endSpawnThreadForTest();
      await p;
    }
    assert.equal(spawnThreadOn(), false);
    assert.match(lines.at(-1) ?? '', /main thread again/);
    const r = await run(node, ['-e', "process.stdout.write('direct')"]);
    assert.equal(r.stdout, 'direct');
  } finally {
    useSpawnThread(false);
  }
});
