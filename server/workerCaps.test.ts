import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAP_LIMITS, CAP_WATCH, capLedgerLine, capNote, capsFor, eventCount, ownCgroup, parsePs, startWorkerCaps, tempWatch, toolPids, treeOf, type CapHit } from '../machine/workerCaps.ts';
import { capNotesHook, pushCapNote } from './workerCapNotes.ts';
import { workerTempDir } from '../machine/agentHost.ts';

// w5554: one worker's agent host and everything it starts are capped on memory, processes and temp disk, so a runaway or
// hijacked worker cannot fill a machine. These tests run their runaways only inside their own process trees.

const GiB = 1024 ** 3;

test('the memory cap is 80% of the machine, at least 8 GiB, whole MiB', () => {
  assert.equal(capsFor(64 * GiB).memoryBytes, Math.floor((64 * GiB * 0.8) / 1048576) * 1048576);
  assert.equal(capsFor(4 * GiB).memoryBytes, 8 * GiB, 'a small machine still lets a worker build');
  assert.equal(capsFor(27e9).memoryBytes % 1048576, 0);
  const c = capsFor(18 * GiB);
  assert.equal(c.processes, CAP_LIMITS.PROCESSES);
  assert.equal(c.tasks, CAP_LIMITS.TASKS);
  assert.equal(c.tempBytes, CAP_LIMITS.TEMP_BYTES);
});

test('the caps sit above the measured heaviest normal worker', () => {
  // three batch Unity builds at once on a 64 GB PC: 24.5 GB of Unity and 21 GB of bcl (w469)
  assert.ok(capsFor(64 * GiB).memoryBytes > 45.5e9);
  // a worker's tree on BEAST peaked at 38 processes (w5554)
  assert.ok(CAP_LIMITS.PROCESSES >= 38 * 50);
  // the biggest worker temp folder measured, 36.5 GB (w3686), and the 15 GB warning before the cap
  assert.ok(CAP_LIMITS.TEMP_BYTES > 36.5e9 && CAP_LIMITS.TEMP_BYTES > 15e9);
});

test("the worker's note names the cap, what was ended and what to do; the ledger line checks the signal's shape", () => {
  const n = capNote({ kind: 'temp', limit: 60e9, seen: 61.2e9, ended: 3 });
  assert.match(n, /temp-folder cap \(60\.0 GB, 61\.2 GB\)/);
  assert.match(n, /ended 3 processes/);
  assert.match(n, /rm -rf "\$TMPDIR\/<name>"/);
  assert.match(capNote({ kind: 'processes', limit: 2048, seen: 2048, ended: 1 }), /process cap \(2048 at once, 2048 running\).*ended 1 process you/);
  assert.match(capNote({ kind: 'memory', limit: 51.2e9, ended: 0 }), /memory cap \(51\.2 GB for the agent and every tool it runs\)/);
  assert.equal(capLedgerLine('0123456789abcdef', { kind: 'memory', limit: 8e9, ended: 2 }), 'worker 01234567 hit its memory cap (8.0 GB for the agent and every tool it runs): FF Factory ended 2 of its tool processes (w5554)');
  for (const bad of [undefined, null, {}, { kind: 'disk', limit: 1, ended: 0 }, { kind: 'temp', limit: '1', ended: 0 }, { kind: 'temp', limit: 1 }]) assert.equal(capLedgerLine('x', bad), undefined);
});

test("a cap note reaches the agent's next own tool result once, never a subagent's", async () => {
  const hook = capNotesHook();
  const call = (agent_id?: string) => hook({ hook_event_name: 'PostToolUse', ...(agent_id ? { agent_id } : {}) } as never, undefined, { signal: new AbortController().signal });
  assert.deepEqual(await call(), {});
  pushCapNote('a');
  pushCapNote('a');
  pushCapNote('b');
  assert.deepEqual(await call('sub'), {});
  assert.deepEqual(await call(), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'a\n\nb' } });
  assert.deepEqual(await call(), {});
});

test('a tree is read from ps; its tools are all but the host and its children', () => {
  const rows = parsePs('  10   1  1000\n 11  10 2000\n12 11 3000\n13 12 4\n 99 1 5\nnot a row\n14 14 1\n');
  assert.deepEqual(rows[0], { pid: 10, ppid: 1, rss: 1000 * 1024 });
  assert.deepEqual(
    treeOf(rows, 10).map((r) => r.pid),
    [10, 11, 12, 13],
  );
  assert.deepEqual(treeOf(rows, 7), []);
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  assert.deepEqual(toolPids([10, 11, 12, 13], 10, (p) => parent.get(p)), [12, 13], 'the host (10) and its claude (11) stay');
});

test("Linux: the scope's own cgroup and its event counters", () => {
  assert.equal(ownCgroup(() => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/ffw-agent-h-1.scope\n'), '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/ffw-agent-h-1.scope');
  assert.equal(ownCgroup(() => '1:name=systemd:/x\n'), undefined);
  assert.equal(
    ownCgroup(() => {
      throw new Error('no /proc');
    }),
    undefined,
  );
  assert.equal(eventCount('low 0\nhigh 0\nmax 3\noom 2\noom_kill 1\n', 'oom_kill'), 1);
  assert.equal(eventCount('low 0\nhigh 0\nmax 3\noom 2\noom_kill 1\n', 'max'), 3);
  assert.equal(eventCount('max 3\n', 'oom_kill'), 0);
});

test('the temp folder is measured first, after a drop of the drive, and at least every TEMP_EVERY_MS', () => {
  let t = 0;
  const w = tempWatch(() => t);
  assert.equal(w.look(100e9), true);
  assert.equal(w.look(99e9), false);
  assert.equal(w.look(100e9 - CAP_WATCH.TEMP_DROP_BYTES), true);
  assert.equal(w.look(101e9), false, 'space came back');
  assert.equal(w.look(101e9 - CAP_WATCH.TEMP_DROP_BYTES), true, 'drops count from where it came back to');
  t += CAP_WATCH.TEMP_EVERY_MS;
  assert.equal(w.look(101e9 - CAP_WATCH.TEMP_DROP_BYTES), true);
});

test("a worker's temp folder is its ffa- folder from its env", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-'));
  try {
    assert.equal(workerTempDir({ TMPDIR: 'relative/ffa-x', TEMP: d }), d);
    assert.equal(workerTempDir({ TMPDIR: path.join(path.dirname(d), 'ffa-gone-w5554') }), undefined);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'w5554-plain-'));
    assert.equal(workerTempDir({ TMPDIR: plain }), undefined, 'not an ffa- folder');
    fs.rmSync(plain, { recursive: true, force: true });
    assert.equal(workerTempDir(undefined), undefined);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ runaways, live

// A stand-in host: on "claude <code>" it starts a child (its claude) running <code>, which starts the tools. Only after the
// caps start, as in the real host (the job holds what is created after it).
const HOST = `
const { spawn } = require('child_process');
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  if (!l.startsWith('claude ')) return;
  const c = spawn(process.execPath, ['-e', l.slice(7)], { stdio: ['ignore', 'pipe', 'ignore'] });
  c.stdout.on('data', (d) => process.stdout.write(d));
  console.log('claude ' + c.pid);
});
setInterval(() => undefined, 1000);
`;

/** A tool that starts `n` sleepers, saying each pid. */
const SLEEPERS = (n: number) => `const { spawn } = require('child_process'); for (let i = 0; i < ${n}; i++) { try { const p = spawn(process.execPath, ['-e', 'setInterval(() => 0, 1000)'], { stdio: 'ignore' }); p.on('error', () => console.log('refused')); if (p.pid) console.log('tool ' + p.pid); } catch { console.log('refused'); } } setInterval(() => 0, 1000);`;

async function withHost(fn: (h: { proc: ChildProcess; lines: string[]; claude: (code: string) => void; until: (re: RegExp, ms?: number) => Promise<string> }) => Promise<void>) {
  const proc = spawn(process.execPath, ['-e', HOST], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines: string[] = [];
  proc.stdout!.on('data', (d: Buffer) => lines.push(...String(d).split('\n').filter(Boolean)));
  const until = async (re: RegExp, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      const l = lines.find((x) => re.test(x));
      if (l) return l;
    }
    throw new Error(`no ${re} in ${JSON.stringify(lines)}`);
  };
  try {
    await fn({ proc, lines, claude: (code) => proc.stdin!.write(`claude ${code}\n`), until });
  } finally {
    // the host's own tree, whatever is left of it
    for (const l of lines) {
      const pid = Number(/^(?:claude|tool) (\d+)$/.exec(l)?.[1]);
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
    }
    proc.kill('SIGKILL');
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function capHit(hits: CapHit[], ms = 30_000): Promise<CapHit> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (hits[0]) return hits[0];
  throw new Error('no cap hit');
}

// One app folder for the job helper (built once, as on a machine); removed when its helpers have exited.
let app: string | undefined;
const appDir = () => (app ??= fs.mkdtempSync(path.join(os.tmpdir(), 'w5554-app-')));
after(() => app && fs.rmSync(app, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

test('a temp folder over its cap ends the tools, not the host or its claude', { timeout: 120_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-w5554-'));
  const app = appDir();
  try {
    await withHost(async (h) => {
      const hits: CapHit[] = [];
      const logs: string[] = [];
      // On a Mac or Linux this exercises the tree path (no ffw scope here); on Windows the job's kill.
      const stop = await startWorkerCaps({
        caps: { memoryBytes: 64 * GiB, processes: 500, tasks: 5000, tempBytes: 1_000_000 },
        tempDir: tmp,
        appDir: app,
        onCap: (x) => hits.push(x),
        log: (s) => logs.push(s),
        hostPid: h.proc.pid,
        watch: { POLL_MS: 200, TEMP_EVERY_MS: 300 },
      });
      try {
        h.claude(SLEEPERS(2));
        const claude = Number((await h.until(/^claude \d+/)).split(' ')[1]);
        // both tools started (a spawn takes a second on a busy machine)
        for (let i = 0; i < 120 && h.lines.filter((l) => l.startsWith('tool ')).length < 2; i++) await new Promise((r) => setTimeout(r, 250));
        const tools = h.lines.filter((l) => l.startsWith('tool ')).map((l) => Number(l.split(' ')[1]));
        assert.equal(tools.length, 2);
        await new Promise((r) => setTimeout(r, 1000));
        assert.deepEqual(hits, [], 'under the cap');
        // the tools fill the folder
        fs.writeFileSync(path.join(tmp, 'big'), Buffer.alloc(2_000_000));
        const hit = await capHit(hits);
        assert.equal(hit.kind, 'temp');
        assert.equal(hit.limit, 1_000_000);
        assert.equal(hit.seen, 2_000_000);
        assert.ok(hit.ended >= 2, JSON.stringify({ hit, logs }));
        await new Promise((r) => setTimeout(r, 500));
        assert.deepEqual(tools.map(alive), [false, false], 'the tools were ended');
        assert.equal(alive(claude), true, 'its claude goes on');
        assert.equal(alive(h.proc.pid!), true, 'the host goes on');
      } finally {
        await stop();
      }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Windows: the job refuses a fork bomb past its process cap and the tools are ended', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
  const app = appDir();
  try {
    await withHost(async (h) => {
      const hits: CapHit[] = [];
      const stop = await startWorkerCaps({ caps: { memoryBytes: 64 * GiB, processes: 8, tasks: 0, tempBytes: 1e12 }, appDir: app, onCap: (x) => hits.push(x), log: () => undefined, hostPid: h.proc.pid });
      try {
        h.claude(SLEEPERS(20));
        const claude = Number((await h.until(/^claude \d+/)).split(' ')[1]);
        await h.until(/^refused$/);
        const hit = await capHit(hits);
        assert.equal(hit.kind, 'processes');
        assert.equal(hit.limit, 8);
        assert.ok(hit.ended >= 5, JSON.stringify(hit));
        assert.equal(alive(claude), true, 'its claude goes on');
        assert.equal(alive(h.proc.pid!), true);
      } finally {
        await stop();
      }
    });
  } finally {
    // the helper is in appDir(), removed after all
  }
});

test("Windows: the job refuses memory past the tree's cap and the tools are ended", { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
  const app = appDir();
  try {
    await withHost(async (h) => {
      const hits: CapHit[] = [];
      const stop = await startWorkerCaps({ caps: { memoryBytes: 1 * GiB, processes: 100, tasks: 0, tempBytes: 1e12 }, appDir: app, onCap: (x) => hits.push(x), log: () => undefined, hostPid: h.proc.pid });
      try {
        // a tool that holds 300 MB, then asks for 2 GB more
        h.claude(
          `const { spawn } = require('child_process'); const p = spawn(process.execPath, ['-e', "const a = Buffer.alloc(300e6, 1); try { Buffer.alloc(2e9, 1); console.log('got it'); } catch (e) { console.log('refused ' + e.code); } setInterval(() => 0, 1000)"], { stdio: ['ignore', 'inherit', 'ignore'] }); console.log('tool ' + p.pid); setInterval(() => 0, 1000);`,
        );
        const claude = Number((await h.until(/^claude \d+/)).split(' ')[1]);
        const hit = await capHit(hits);
        assert.equal(hit.kind, 'memory');
        assert.equal(hit.limit, 1 * GiB);
        assert.equal(h.lines.includes('got it'), false);
        assert.equal(alive(claude), true, 'its claude goes on');
        assert.equal(alive(h.proc.pid!), true);
      } finally {
        await stop();
      }
    });
  } finally {
    // the helper is in appDir(), removed after all
  }
});

test('a normal tree under the caps is left alone', { timeout: 120_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-w5554-'));
  const app = appDir();
  try {
    await withHost(async (h) => {
      const hits: CapHit[] = [];
      const stop = await startWorkerCaps({ caps: capsFor(), tempDir: tmp, appDir: app, onCap: (x) => hits.push(x), log: () => undefined, hostPid: h.proc.pid });
      try {
        h.claude(SLEEPERS(40));
        await h.until(/^claude \d+/);
        // 40 node processes start in some seconds on a busy machine
        for (let i = 0; i < 240 && h.lines.filter((l) => l.startsWith('tool ')).length < 40; i++) await new Promise((r) => setTimeout(r, 250));
        await new Promise((r) => setTimeout(r, CAP_WATCH.POLL_MS * 2));
        assert.equal(h.lines.filter((l) => l.startsWith('tool ')).length, 40);
        assert.equal(h.lines.includes('refused'), false);
        assert.deepEqual(hits, []);
      } finally {
        await stop();
      }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
