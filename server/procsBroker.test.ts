import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcsBroker, askDaemon, execRefused, orDaemon, parseAsk, procsMailbox, STALE_MS, type ProcsAsk } from '../machine/procsBroker.ts';
import { answerProcsAsk, leftoversMain, workerReaders, type ProcEnv, type ProcReaders } from '../machine/leftovers.ts';
import { stopTree } from '../machine/unitySlots.ts';
import type { ProcFacts } from '../machine/unityReaper.ts';
import type { Proc } from '../machine/unity.ts';

/**
 * w5397: under the Seatbelt worker fence a worker cannot exec the setuid /bin/ps (m5, 2026-11-24, w5393: "operation not
 * permitted: ps"; `ff-leftovers list` and `end` died on "spawn EPERM"). The daemon, outside the fence, reads the processes
 * for it through a file mailbox (machine/procsBroker.ts). A live fenced run cannot be nested inside a fenced worker
 * (sandbox_apply refuses) and CI runs on Linux, so `ps` is refused here the way Node refuses it: execFile throws an
 * Error with code EPERM, message "spawn EPERM".
 */

const refused = () => Object.assign(new Error('spawn EPERM'), { code: 'EPERM', errno: -1, syscall: 'spawn' });
const epermReaders: ProcReaders = {
  procs: async () => {
    throw refused();
  },
  envs: async () => {
    throw refused();
  },
  inspect: async () => {
    throw refused();
  },
};

/** A mailbox folder and a broker answering in it every 20 ms, as the daemon does every 250 ms. */
function withBroker(answer: (a: ProcsAsk) => Promise<unknown>) {
  const slots = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'procs-broker-'));
  const dir = procsMailbox(slots);
  const broker = new ProcsBroker({ dir, answer });
  void broker.tick();
  const timer = setInterval(() => void broker.tick(), 20);
  return {
    slots,
    dir,
    broker,
    done: () => {
      clearInterval(timer);
      fs.rmSync(slots, { recursive: true, force: true });
    },
  };
}

test('execRefused: the sandbox refusing an exec (EPERM, EACCES), not a missing program or a failed run', () => {
  assert.ok(execRefused(refused()));
  assert.ok(execRefused(Object.assign(new Error('spawn /bin/ps EACCES'), { code: 'EACCES' })));
  assert.ok(execRefused(new Error('spawnSync ps EPERM')));
  assert.ok(!execRefused(Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' })));
  assert.ok(!execRefused(new Error('ps failed (1)')));
  assert.ok(!execRefused(undefined));
});

test('parseAsk answers only the three fixed reads, with whole positive pids', () => {
  assert.deepEqual(parseAsk('{"op":"procs","pids":[1]}'), { op: 'procs' });
  assert.deepEqual(parseAsk('{"op":"env","pids":[3,3,-1,2.5,"x",7]}'), { op: 'env', pids: [3, 7] });
  assert.equal(parseAsk('{"op":"kill","pids":[3]}'), undefined);
  assert.equal(parseAsk('{"op":"env"}'), undefined);
  assert.equal(parseAsk('not json'), undefined);
});

test('a worker whose ps is refused gets the daemon\'s answers through the mailbox', async () => {
  const machine: Proc[] = [{ pid: 300, ppid: 1, cmd: 'sleep 600' }];
  const b = withBroker(answerProcsAsk('darwin', {
    procs: async () => machine,
    envs: async (pids) => new Map(pids.filter((p) => p === 300).map((p) => [p, { session: 's1' } as ProcEnv])),
    inspect: async (pids) => pids.map((pid) => ({ pid, startedAt: 1000, cpuMs: 5 })),
  }));
  try {
    const r = workerReaders('darwin', b.dir, epermReaders);
    assert.deepEqual(await r.procs(), machine);
    assert.deepEqual([...(await r.envs([300, 301]))], [[300, { session: 's1' }]]);
    assert.deepEqual(await r.inspect([300]), [{ pid: 300, startedAt: 1000, cpuMs: 5 }]);
    assert.deepEqual(fs.readdirSync(b.dir), [], 'every ask and answer is taken away');
  } finally {
    b.done();
  }
});

test('unfenced, the worker\'s own ps answers and the daemon is never asked; another failure is not hidden', async () => {
  let asked = 0;
  const ask = (async () => {
    asked++;
    return [];
  }) as typeof askDaemon;
  const own: Proc[] = [{ pid: 9, ppid: 1, cmd: 'x' }];
  const r = workerReaders('darwin', '/nowhere', { ...epermReaders, procs: async () => own }, ask);
  assert.deepEqual(await r.procs(), own);
  assert.equal(asked, 0);
  await assert.rejects(orDaemon(async () => Promise.reject(new Error('ps failed (2)')), async () => 'daemon'), /ps failed/);
  assert.equal(await orDaemon(async () => Promise.reject(refused()), async () => 'daemon'), 'daemon');
});

test('the daemon answers a bad ask with an error, and a read that fails says so to the worker', async () => {
  const b = withBroker(async () => {
    throw new Error('ps -E timed out');
  });
  try {
    await assert.rejects(askDaemon(b.dir, { op: 'procs' }, { timeoutMs: 5_000 }), /the daemon could not read the processes: ps -E timed out/);
    fs.writeFileSync(path.join(b.dir, 'ask-bad.json'), '{"op":"rm"}');
    await new Promise((r) => setTimeout(r, 100));
    assert.match(fs.readFileSync(path.join(b.dir, 'ans-bad.json'), 'utf8'), /not an ask this mailbox answers/);
  } finally {
    b.done();
  }
});

test('no daemon answering: the worker is told why within its timeout, and leaves no ask behind', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'procs-nobody-'));
  try {
    await assert.rejects(askDaemon(dir, { op: 'procs' }, { timeoutMs: 200, pollMs: 20 }), /ps is refused here \(the worker fence\) and the daemon did not answer/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the daemon drops a stale ask unanswered and removes answers nobody took', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'procs-stale-'));
  try {
    let answered = 0;
    let now = Date.now();
    const broker = new ProcsBroker({ dir, answer: async () => ++answered, now: () => now });
    fs.writeFileSync(path.join(dir, 'ask-old.json'), '{"op":"procs"}');
    fs.writeFileSync(path.join(dir, 'ans-left.json'), '{"ok":true,"result":1}');
    now += STALE_MS + 1_000;
    assert.equal(await broker.tick(), 0);
    assert.equal(answered, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fenced ff-leftovers lists and ends what its session left, through the daemon', async () => {
  // The agent's host (no FF variables), its claude (the session's root, spared), and a background sleep of the session
  // reparented to launchd: the one leftover.
  let machine: Proc[] = [
    { pid: 50, ppid: 1, cmd: 'node agentHost.ts' },
    { pid: 100, ppid: 50, cmd: 'claude --print' },
    { pid: 300, ppid: 1, cmd: 'sleep 600' },
  ];
  const envs = new Map<number, ProcEnv>([
    [100, { session: 's1', machine: 'm5' }],
    [300, { session: 's1', machine: 'm5' }],
  ]);
  const b = withBroker(answerProcsAsk('darwin', {
    procs: async () => machine,
    envs: async (pids) => new Map(pids.filter((p) => envs.has(p)).map((p) => [p, envs.get(p)!])),
    inspect: async (pids): Promise<ProcFacts[]> => pids.map((pid) => ({ pid, startedAt: Date.now() - 60_000, cpuMs: 1 })),
  }));
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
  const sent: [number, string][] = [];
  try {
    const e = { FF_SESSION_ID: 's1', FF_MACHINE_ID: 'm5', FF_UNITY_SLOTS: b.slots };
    const t = {
      platform: 'darwin' as const,
      read: workerReaders('darwin', b.dir, epermReaders),
      signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => {
        sent.push([pid, sig]);
        machine = machine.filter((p) => p.pid !== pid);
      },
      wait: async () => undefined,
    };
    assert.equal(await leftoversMain(['list'], e, t), 0);
    assert.match(out.join(''), /Still running from your session \(s1\): 1\n\s+pid 300 .*sleep 600/);
    assert.deepEqual(sent, [], 'list ends nothing');
    out.length = 0;
    assert.equal(await leftoversMain(['end'], e, t), 0);
    assert.deepEqual(sent, [[300, 'SIGTERM']]);
    assert.match(out.join(''), /Ended 1 of 1 process\(es\) your session \(s1\) started/);
    out.length = 0;
    assert.equal(await leftoversMain(['list'], e, t), 0);
    assert.match(out.join(''), /Nothing your session \(s1\) started is still running/);
  } finally {
    process.stdout.write = write;
    b.done();
  }
});

test('stopTree: when ps is refused (it prints nothing), pgrep -P finds the tree', () => {
  const calls: string[] = [];
  const kids: Record<string, string> = { '10': '11\n12\n', '11': '13\n', '12': '', '13': '' };
  const sh = (c: string, a: string[]) => {
    calls.push([c, ...a].join(' '));
    return c === 'pgrep' ? (kids[a[1]] ?? '') : '';
  };
  const signalled: number[] = [];
  const real = process.kill;
  process.kill = ((pid: number) => (signalled.push(pid), true)) as typeof process.kill;
  try {
    stopTree(10, 'darwin', 60_000, sh);
  } finally {
    process.kill = real;
  }
  assert.deepEqual(signalled, [10, 11, 12, 13]);
  assert.ok(calls.includes('pgrep -P 10'));
});
