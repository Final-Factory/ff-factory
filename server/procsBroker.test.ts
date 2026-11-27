import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcsBroker, askDaemon, execRefused, orDaemon, parseAsk, procsMailbox, STALE_MS, type ProcsAsk } from '../machine/procsBroker.ts';
import { answerProcsAsk, leftoversMain, slotContext, workerCensus, workerReaders, type ProcEnv, type ProcReaders } from '../machine/leftovers.ts';
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

test('parseAsk answers only the fixed reads, with who asks and whole positive pids', () => {
  const who = { session: 's1', pid: 42 };
  const w = '"who":{"session":"s1","pid":42}';
  assert.deepEqual(parseAsk(`{"op":"procs","pids":[1],${w}}`), { op: 'procs', who });
  assert.deepEqual(parseAsk(`{"op":"census",${w}}`), { op: 'census', who });
  assert.deepEqual(parseAsk(`{"op":"env","pids":[3,3,-1,2.5,"x",7],${w}}`), { op: 'env', pids: [3, 7], who });
  assert.equal(parseAsk(`{"op":"kill","pids":[3],${w}}`), undefined);
  assert.equal(parseAsk(`{"op":"env",${w}}`), undefined);
  // w5558: an ask that names no asker, or a malformed one, is not answered.
  assert.equal(parseAsk('{"op":"procs"}'), undefined);
  assert.equal(parseAsk('{"op":"procs","who":{"session":"s1"}}'), undefined);
  assert.equal(parseAsk('{"op":"procs","who":{"session":"../x y","pid":42}}'), undefined);
  assert.equal(parseAsk('{"op":"procs","who":{"session":"s1","pid":-4}}'), undefined);
  assert.equal(parseAsk('not json'), undefined);
});

/** The asking ff-leftovers (pid ME) of session s1, under claude (100). */
const ME = 400;
const WHO = { session: 's1', pid: ME };

test('a worker whose ps is refused gets the daemon\'s answers through the mailbox', async () => {
  const machine: Proc[] = [
    { pid: 100, ppid: 1, cmd: 'claude --print' },
    { pid: 300, ppid: 1, cmd: 'sleep 600' },
    { pid: ME, ppid: 100, cmd: 'node ff-leftovers list' },
  ];
  const b = withBroker(answerProcsAsk('darwin', {
    procs: async () => machine,
    envs: async (pids) => new Map(pids.filter((p) => p !== 1).map((p) => [p, { session: 's1' } as ProcEnv])),
    inspect: async (pids) => pids.map((pid) => ({ pid, startedAt: 1000, cpuMs: 5 })),
  }));
  try {
    const r = workerReaders('darwin', b.dir, epermReaders, askDaemon, WHO);
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
    await assert.rejects(askDaemon(b.dir, { op: 'procs', who: WHO }, { timeoutMs: 5_000 }), /the daemon could not read the processes: ps -E timed out/);
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
  // This test's own process is the asking ff-leftovers, under claude.
  let machine: Proc[] = [
    { pid: 50, ppid: 1, cmd: 'node agentHost.ts' },
    { pid: 100, ppid: 50, cmd: 'claude --print' },
    { pid: 300, ppid: 1, cmd: 'sleep 600' },
    { pid: process.pid, ppid: 100, cmd: 'node ff-leftovers.ts list' },
  ];
  const envs = new Map<number, ProcEnv>([
    [100, { session: 's1', machine: 'm5' }],
    [300, { session: 's1', machine: 'm5' }],
    [process.pid, { session: 's1', machine: 'm5' }],
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
      read: workerReaders('darwin', b.dir, epermReaders, askDaemon, { session: 's1', pid: process.pid }),
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

test('stopTree: when ps is refused (it prints nothing), pgrep -P finds the tree', (t) => {
  // w5619: stopTree's SIGKILL timer, mocked here. A real one kept this file's process up 60 s on CI, then sent SIGKILL
  // to pids 10-13 of the runner with process.kill restored.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  const kids: Record<string, string> = { '10': '11\n12\n', '11': '13\n', '12': '', '13': '' };
  const sh = (c: string, a: string[]) => {
    calls.push([c, ...a].join(' '));
    return c === 'pgrep' ? (kids[a[1]] ?? '') : '';
  };
  const signalled: [number, string | number | undefined][] = [];
  const real = process.kill;
  process.kill = ((pid: number, sig?: string | number) => (signalled.push([pid, sig]), true)) as typeof process.kill;
  try {
    stopTree(10, 'darwin', 60_000, sh);
    assert.deepEqual(signalled.map(([p]) => p), [10, 11, 12, 13]);
    t.mock.timers.tick(60_000);
  } finally {
    process.kill = real;
  }
  assert.deepEqual(signalled, [10, 11, 12, 13].map((p) => [p, 'SIGTERM']).concat([10, 11, 12, 13].map((p) => [p, 'SIGKILL'])));
  assert.ok(calls.includes('pgrep -P 10'));
});

// ---------------------------------------------------------------- w5558: each worker sees only its own processes

/**
 * One Mac with the daemon, two workers (s1 in slot1, s2 in slot2) and the owner's own programs. s1 asks (ff-leftovers,
 * pid ME, from its zsh 110). 110 is an Apple zsh whose environment reads empty: its shell record names it s1, and so the
 * `/bin/sleep` it left reparented to launchd (310, same process group) is s1's too (w5401).
 */
const ROOT = '/Users/x/ffw';
const twoWorkers = (): { machine: Proc[]; envs: Map<number, ProcEnv>; readers: ProcReaders; inspected: number[][] } => {
  const machine: Proc[] = [
    { pid: 1, ppid: 0, cmd: '/sbin/launchd' },
    { pid: 10, ppid: 1, cmd: `node ${ROOT}/daemon/src/machine/daemon.ts` },
    { pid: 50, ppid: 10, cmd: `node ${ROOT}/daemon/src/machine/agentHost.ts ${ROOT}/daemon/hosts/s1` },
    { pid: 100, ppid: 50, cmd: 'claude --print' },
    { pid: 110, ppid: 100, cmd: '/bin/zsh -c ff-leftovers list', pgid: 110 },
    { pid: 120, ppid: 110, cmd: 'python3 bench.py', pgid: 110 },
    { pid: 130, ppid: 120, cmd: '/bin/sleep 5', pgid: 110 },
    { pid: 140, ppid: 100, cmd: 'node other-session-tool.js' },
    { pid: 300, ppid: 1, cmd: 'python3 -m http.server' },
    { pid: 310, ppid: 1, cmd: '/bin/sleep 900', pgid: 110 },
    { pid: ME, ppid: 110, cmd: 'node ff-leftovers.ts list', pgid: 110 },
    { pid: 60, ppid: 10, cmd: `node ${ROOT}/daemon/src/machine/agentHost.ts ${ROOT}/daemon/hosts/s2` },
    { pid: 200, ppid: 60, cmd: 'claude --print' },
    { pid: 210, ppid: 200, cmd: `/Applications/Unity/Unity -batchmode -projectPath ${ROOT}/sandboxes/slot2` },
    { pid: 220, ppid: 1, cmd: 'sleep 600' },
    { pid: 900, ppid: 1, cmd: '/Applications/Safari.app/Contents/MacOS/Safari' },
  ];
  const envs = new Map<number, ProcEnv>([
    [10, { root: ROOT, machine: 'm5' }],
    [100, { session: 's1', sandbox: 'slot1', machine: 'm5' }],
    [120, { session: 's1', sandbox: 'slot1', machine: 'm5' }],
    [140, { session: 's2', sandbox: 'slot2', machine: 'm5' }],
    [300, { session: 's1', sandbox: 'slot1', machine: 'm5' }],
    [ME, { session: 's1', sandbox: 'slot1', machine: 'm5' }],
    [200, { session: 's2', sandbox: 'slot2', machine: 'm5' }],
    [210, { session: 's2', sandbox: 'slot2', machine: 'm5' }],
    [220, { session: 's2', sandbox: 'slot2', machine: 'm5' }],
  ]);
  const inspected: number[][] = [];
  return {
    machine,
    envs,
    inspected,
    readers: {
      procs: async () => machine,
      envs: async (pids) => new Map(pids.filter((p) => envs.has(p)).map((p) => [p, envs.get(p)!])),
      inspect: async (pids) => {
        inspected.push(pids);
        return pids.map((pid) => ({ pid, startedAt: 1_000, cpuMs: 1 }));
      },
    },
  };
};
const s1Groups = (session: string) => (session === 's1' ? [{ leader: 110, start: 1_000, env: { session: 's1', sandbox: 'slot1', machine: 'm5' } }] : []);
const sorted = (pids: number[]) => [...pids].sort((a, b) => a - b);

test('w5558: the daemon shows a worker its own processes, and not another slot\'s, the daemon\'s or the owner\'s', async () => {
  const w = twoWorkers();
  const answer = answerProcsAsk('darwin', w.readers, { root: ROOT, groups: s1Groups });
  const procs = (await answer({ op: 'procs', who: WHO })) as Proc[];
  // Its own: claude and what it runs (the zsh, python, the sleep under it), its orphans by session (300) and by shell
  // group (310), and itself; the parents of those without their environment (its agent host 50, launchd).
  assert.deepEqual(sorted(procs.map((p) => p.pid)), [1, 50, 100, 110, 120, 130, 300, 310, ME]);
  // Never s2's claude, its batch Unity, its orphan or the tool of s2 that s1's claude started; never the daemon or Safari.
  for (const pid of [10, 60, 140, 200, 210, 220, 900]) assert.ok(!procs.some((p) => p.pid === pid), `pid ${pid} is not s1's`);
  // Environments: only of its own processes (shell groups filled in); none of the parents, of s2, of the daemon.
  const env = new Map((await answer({ op: 'env', pids: w.machine.map((p) => p.pid), who: WHO })) as [number, ProcEnv][]);
  assert.deepEqual(sorted([...env.keys()]), [100, 110, 120, 130, 300, 310, ME]);
  assert.ok([...env.values()].every((e) => e.session === 's1'));
  // Start times: only of what it may see; the others are not even read.
  w.inspected.length = 0;
  const facts = (await answer({ op: 'inspect', pids: [100, 200, 210, 900, 10], who: WHO })) as ProcFacts[];
  assert.deepEqual(facts.map((f) => f.pid), [100]);
  assert.deepEqual(w.inspected.at(-1), [100]);
  assert.deepEqual(await answer({ op: 'inspect', pids: [200, 900], who: WHO }), []);
  // s2 asking from its claude sees its own and none of s1's.
  const theirs = (await answer({ op: 'procs', who: { session: 's2', pid: 200 } })) as Proc[];
  // 140 carries s2 though s1's claude started it: s2's, and its parent (s1's claude) is not shown.
  assert.deepEqual(sorted(theirs.map((p) => p.pid)), [1, 60, 140, 200, 210, 220]);
});

test('w5558: an asker that is not of the session it names, not running, or names none is refused', async () => {
  const w = twoWorkers();
  const answer = answerProcsAsk('darwin', w.readers, { root: ROOT, groups: s1Groups });
  await assert.rejects(answer({ op: 'procs', who: { session: 's2', pid: ME } }), /process 400 is not of session s2/);
  await assert.rejects(answer({ op: 'env', pids: [200], who: { session: 's2', pid: 300 } }), /not of session s2/);
  await assert.rejects(answer({ op: 'procs', who: { session: 's1', pid: 900 } }), /process 900 is not of session s1/);
  await assert.rejects(answer({ op: 'procs', who: { session: 's1', pid: 10 } }), /not of session s1/, 'the daemon is no worker');
  await assert.rejects(answer({ op: 'procs', who: { session: 's1', pid: 4242 } }), /process 4242 is not running/);
  await assert.rejects(answer({ op: 'procs' }), /names no session/);
  // Through the mailbox: an ask with no asker gets the format error, a forged one the refusal, and no process data.
  const b = withBroker(answer);
  try {
    await assert.rejects(askDaemon(b.dir, { op: 'procs' }, { timeoutMs: 5_000 }), /not an ask this mailbox answers/);
    await assert.rejects(askDaemon(b.dir, { op: 'env', pids: [200, 210], who: { session: 's2', pid: ME } }, { timeoutMs: 5_000 }), /could not read the processes: process 400 is not of session s2/);
  } finally {
    b.done();
  }
});

test('w5558: the clean-up\'s census gives the command lines under the install folder and the agent hosts, with no environment', async () => {
  const w = twoWorkers();
  const answer = answerProcsAsk('darwin', w.readers, { root: ROOT, groups: s1Groups });
  const census = (await answer({ op: 'census', who: WHO })) as Proc[];
  assert.deepEqual(sorted(census.map((p) => p.pid)), [10, 50, 60, 210]);
  for (const p of census) assert.deepEqual(Object.keys(p).sort(), ['cmd', 'pid', 'ppid'], 'pid, ppid and command only');
  await assert.rejects(answerProcsAsk('darwin', w.readers)({ op: 'census', who: WHO }), /no install folder/, 'no root: no census, so the clean-up keeps');
  await assert.rejects(answer({ op: 'census', who: { session: 's2', pid: ME } }), /not of session s2/);
  // Fenced, ff-leftovers folders/check still sees that slot2's sandbox is in use and that both hosts run.
  const b = withBroker(answer);
  try {
    const ctx = await slotContext({ procs: workerCensus('darwin', b.dir, epermReaders, askDaemon, WHO), self: ME, callers: [], session: 's1' });
    assert.ok(ctx.procs?.some((c) => c.includes(`${ROOT}/sandboxes/slot2`)), 'a batch Unity of another slot keeps its sandbox');
    assert.deepEqual(ctx.hosts?.sort(), ['s1', 's2']);
    assert.ok(!ctx.procs?.some((c) => c.includes('Safari')), 'the owner\'s programs are not shown');
  } finally {
    b.done();
  }
});

// ---------------------------------------------------------------- w5615: a mailbox per sandbox

test('w5615: procsMailbox is procs/<sandbox> for a sandbox worker and the shared procs folder for anyone else', () => {
  const dir = path.join(path.sep, 'slots');
  assert.equal(procsMailbox(dir, 'slot3'), path.join(dir, 'procs', 'slot3'));
  assert.equal(procsMailbox(dir, 'w5615.x-2'), path.join(dir, 'procs', 'w5615.x-2'));
  assert.equal(procsMailbox(dir), path.join(dir, 'procs'));
  for (const bad of ['', '..', '../slot3', 'a/b', 'a\\b', 'a..b', '.hidden', 'a b', 'x'.repeat(65)]) assert.equal(procsMailbox(dir, bad), path.join(dir, 'procs'), `"${bad}" falls back to the shared mailbox`);
});

test('w5615: the daemon answers an ask in the sandbox subfolder it was written in, and in the shared folder as before', async () => {
  const slots = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'procs-sandbox-'));
  try {
    const seen: string[] = [];
    const broker = new ProcsBroker({
      dir: procsMailbox(slots),
      answer: async (a) => {
        seen.push(a.op);
        return `answer to ${a.op}`;
      },
    });
    const mine = procsMailbox(slots, 'slot3');
    const theirs = procsMailbox(slots, 'slot4');
    const shared = procsMailbox(slots);
    for (const d of [mine, theirs]) fs.mkdirSync(d, { recursive: true });
    const ask = (op: string) => JSON.stringify({ op, who: WHO });
    fs.writeFileSync(path.join(mine, 'ask-a1.json'), ask('procs'));
    fs.writeFileSync(path.join(theirs, 'ask-b1.json'), ask('census'));
    fs.writeFileSync(path.join(shared, 'ask-c1.json'), ask('procs'));
    assert.equal(await broker.tick(), 3);
    assert.deepEqual(seen.sort(), ['census', 'procs', 'procs']);
    // each answer is beside its ask, and only there
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mine, 'ans-a1.json'), 'utf8')), { ok: true, result: 'answer to procs' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(theirs, 'ans-b1.json'), 'utf8')), { ok: true, result: 'answer to census' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shared, 'ans-c1.json'), 'utf8')), { ok: true, result: 'answer to procs' });
    assert.deepEqual(fs.readdirSync(mine), ['ans-a1.json']);
    assert.deepEqual(fs.readdirSync(theirs), ['ans-b1.json']);
    assert.deepEqual(fs.readdirSync(shared).filter((n) => n.endsWith('.json')), ['ans-c1.json']);
    assert.equal(await broker.tick(), 0, 'nothing left to answer');
  } finally {
    fs.rmSync(slots, { recursive: true, force: true });
  }
});

test('w5615: a worker asking through its sandbox mailbox is answered there, a bad ask too, and a stale answer in a subfolder is removed', async () => {
  const slots = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'procs-sandbox-'));
  try {
    let now = Date.now();
    const broker = new ProcsBroker({ dir: procsMailbox(slots), answer: async () => 'ok', now: () => now });
    const mine = procsMailbox(slots, 'slot3');
    const timer = setInterval(() => void broker.tick(), 20);
    try {
      // askDaemon makes the subfolder itself (the daemon may not have seen the sandbox yet)
      assert.equal(await askDaemon<string>(mine, { op: 'procs', who: WHO }, { timeoutMs: 5_000, pollMs: 10 }), 'ok');
      fs.writeFileSync(path.join(mine, 'ask-bad.json'), '{"op":"rm"}');
      await new Promise((r) => setTimeout(r, 100));
      assert.match(fs.readFileSync(path.join(mine, 'ans-bad.json'), 'utf8'), /not an ask this mailbox answers/);
    } finally {
      clearInterval(timer);
    }
    now += STALE_MS + 1_000;
    await broker.tick();
    assert.deepEqual(fs.readdirSync(mine), [], 'the answer nobody took goes after a while, in the subfolder too');
  } finally {
    fs.rmSync(slots, { recursive: true, force: true });
  }
});
