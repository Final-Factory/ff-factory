import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAP_LIMITS, CAP_WATCH, anonBytes, capLedgerLine, capNote, capsFor, capsModeOf, eventCount, ownCgroup, parsePs, sameProcess, sparedByEnv, sparedPids, startWorkerCaps, tempWatch, toolPids, toolsToEnd, treeOf, type CapHit, type PsRow } from '../machine/workerCaps.ts';
import { capNotesHook, pushCapNote } from './workerCapNotes.ts';
import { EventEmitter } from 'node:events';
import { HostedSession, hostCommand, workerTempDir, type HostDeps, type HostStart } from '../machine/agentHost.ts';
import type { SessionInfo } from '../shared/types.ts';

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

test('w5554: the mode is warn unless daemon.json says off or enforce; a typo never enforces', () => {
  assert.equal(capsModeOf(undefined), 'warn');
  assert.equal(capsModeOf('off'), 'off');
  assert.equal(capsModeOf('enforce'), 'enforce');
  assert.equal(capsModeOf('warn'), 'warn');
  for (const bad of ['Enforce', 'on', '', null, 1, {}]) assert.equal(capsModeOf(bad), 'warn');
});

test('w5554/w5766: a warn note reads as a note: nothing was stopped, carry on, one tip, a line in the report', () => {
  const h: CapHit = { kind: 'memory', limit: 51.2e9, seen: 60e9, ended: 0, warn: true };
  const n = capNote(h);
  assert.match(n, /^For your information: your tools went past the memory cap \(51\.2 GB for the agent and every tool it runs, 60\.0 GB\)/);
  assert.match(n, /nothing was stopped and you can carry on/);
  assert.match(n, /running fewer keeps you clear of the cap/);
  assert.match(n, /Please mention it in your report\.$/);
  // w5766 (the reviews of w5554): no wording that reads as a stop or a fault
  assert.doesNotMatch(n, /stopped your tools|ended \d|would have hit|Before you go on|must/);
  assert.match(capNote({ ...h, kind: 'temp', limit: 60e9, seen: 61e9 }), /rm -rf "\$TMPDIR\/<name>"/);
  assert.match(capNote({ ...h, kind: 'processes', limit: 2048, seen: 3000 }), /keeps starting processes/);
  assert.equal(capLedgerLine('0123456789abcdef', h), 'worker 01234567 went past its memory cap (51.2 GB for the agent and every tool it runs, 60.0 GB) (measured only: nothing was stopped; w5554)');
  assert.match(capLedgerLine('0123456789abcdef', { kind: 'processes', limit: 2048, seen: 3000, ended: 0, warn: true }) ?? '', /went past its process cap \(2048 at once, 3000 running\) \(measured only: nothing was stopped/);
  // the kernel acted (Linux enforce): said, with nothing of ours ended
  const k: CapHit = { kind: 'memory', limit: 51.2e9, ended: 0, kernel: true };
  assert.match(capNote(k), /the kernel ended the biggest process of your scope.*ended nothing else/);
  assert.match(capLedgerLine('0123456789abcdef', k) ?? '', /FF Factory ended nothing/);
  // a plain enforce hit is as before
  assert.match(capNote({ kind: 'memory', limit: 51.2e9, ended: 2 }), /stopped your tools/);
});

test('w5554: tools are ended only when the process list proves who the host is', () => {
  const rows = parsePs('10 1 100\n11 10 100\n12 11 100\n13 12 100\n');
  assert.deepEqual(toolsToEnd(rows, 10, [10, 11, 12, 13]).pids, [12, 13], 'the host and its claude stay');
  const none = toolsToEnd([], 10, [10, 11, 12, 13]);
  assert.deepEqual(none.pids, []);
  assert.match(none.why ?? '', /list was empty/);
  const noHost = toolsToEnd(rows, 99, [10, 11, 12, 13]);
  assert.deepEqual(noHost.pids, []);
  assert.match(noHost.why ?? '', /host \(pid 99\) is not in the process list/);
  assert.deepEqual(toolsToEnd(rows, 10, [11, 12, 77]).pids, [12], 'a pid the list lacks is left alone');
});

test('w5766: a kill re-reads the list and ends a pid only if it is the same process (pid, parent, start time)', () => {
  const rows = parsePs('  10     1   100 Tue Nov 25 10:00:01 2026\n  12    11   200 Tue Nov 25  10:05:00 2026\n  13 12 300\n');
  assert.deepEqual(rows[0], { pid: 10, ppid: 1, rss: 100 * 1024, start: 'Tue Nov 25 10:00:01 2026' });
  assert.equal(rows[1]!.start, 'Tue Nov 25 10:05:00 2026', 'runs of spaces (a padded day) are one');
  assert.equal(rows[2]!.start, undefined, 'a ps without lstart still parses');
  const a: PsRow = { pid: 12, ppid: 11, rss: 0, start: 'Tue Nov 25 10:05:00 2026' };
  assert.equal(sameProcess(a, { ...a, rss: 999 }), true, 'memory moves; the process is the same');
  assert.equal(sameProcess(a, { ...a, start: 'Tue Nov 25 10:05:02 2026' }), false, 'a reused pid starts later');
  assert.equal(sameProcess(a, { ...a, ppid: 1 }), false);
  assert.equal(sameProcess(a, undefined), false, 'gone');
  assert.equal(sameProcess({ ...a, start: undefined }, { ...a, start: undefined }), false, 'no start time: it cannot be told apart, so it is not ended');
});

test('w5766: a kill spares the Unity MCP server and ff-leftovers launch programs, by their environment', () => {
  assert.equal(sparedByEnv({ session: 's1', mcp: '1' }), true, 'UnityMCP (and its uvx and python)');
  assert.equal(sparedByEnv({ person: 's1' }), true, 'a program started for a person');
  assert.equal(sparedByEnv({ session: 's1', person: 's1' }), false, 'a session of its own: a tool that set the marker');
  assert.equal(sparedByEnv({ session: 's1' }), false);
  assert.equal(sparedByEnv(undefined), false);
  assert.deepEqual([...sparedPids(new Map([[5, { session: 's', mcp: '1' }], [6, { session: 's' }], [7, { person: 's' }]]))], [5, 7]);
});

test('w5766: Linux memory is the anonymous memory of memory.stat, not the page cache', () => {
  assert.equal(anonBytes('anon 4096\nfile 9000000000\nkernel 100\n'), 4096);
  assert.equal(anonBytes('file 9000000000\nanon_thp 0\n'), -1, 'anon_thp is not anon');
  assert.equal(anonBytes(''), -1);
});

const hostInfo = (kind: SessionInfo['kind']): SessionInfo => ({ id: 'w5766-host', kind, title: 'w5766', status: 'running', permissionMode: 'default', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), turns: 1, costUsd: 0, pendingPermissions: [] });
const hostStart = (kind: SessionInfo['kind'], capsMode?: HostStart['capsMode']): HostStart => ({ hostProtocol: 1, info: hostInfo(kind), seq: 0, spec: { cwd: os.tmpdir() } as never, editorUp: undefined, ...(capsMode ? { capsMode } : {}) }) as HostStart;

test("w5766: Linux: a worker host's scope gets MemoryMax and TasksMax only in enforce", () => {
  const linux = { platform: 'linux' as const, usable: () => true, oom: () => true, limitsOk: () => true };
  const lim = (c: { args: string[] }) => c.args.filter((a) => /^(MemoryMax|TasksMax)=/.test(a));
  const enforce = hostCommand('/x/hosts/w5766', hostStart('worker', 'enforce'), linux);
  assert.equal(enforce.bin, 'systemd-run');
  assert.deepEqual(lim(enforce), [`MemoryMax=${capsFor().memoryBytes}`, `TasksMax=${capsFor().tasks}`]);
  assert.equal(enforce.limited, true);
  for (const mode of ['warn', 'off', undefined, 'enforced'] as (HostStart['capsMode'] | undefined)[]) {
    const c = hostCommand('/x/hosts/w5766', hostStart('worker', mode), linux);
    assert.equal(c.bin, 'systemd-run', `${mode}: still its own scope`);
    assert.deepEqual(lim(c), [], `${mode}: no limits`);
    assert.equal(c.capped, false);
  }
  assert.deepEqual(lim(hostCommand('/x/hosts/w5766', hostStart('orchestrator', 'enforce'), linux)), [], 'an orchestrator is never capped');
  assert.deepEqual(lim(hostCommand('/x/hosts/w5766', hostStart('worker', 'enforce'), { ...linux, oom: () => false })), [], 'no OOMPolicy=continue: no limits (w2884)');
  assert.equal(hostCommand('/x/hosts/w5766', hostStart('worker', 'enforce'), { platform: 'win32' }).bin, process.execPath, 'not Linux: no scope');
});

test("w5766: the daemon's caps mode reaches the host's start record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5766-start-'));
  try {
    for (const mode of ['off', 'warn', 'enforce'] as const) {
      const starts: HostStart[] = [];
      const deps: HostDeps = {
        root,
        out: () => undefined,
        events: new EventEmitter(),
        handlers: () => ({}),
        spec: () => ({ cwd: root }) as never,
        editorUp: () => undefined,
        changed: () => undefined,
        log: () => undefined,
        launch: (_dir, start) => {
          starts.push(start);
          throw new Error('no host process in this test');
        },
        stopping: () => undefined,
        capsMode: () => mode,
      };
      const s = new HostedSession({ ...hostInfo('worker'), id: `w5766-${mode}` }, 0, deps);
      s.send('hello', 'orchestrator');
      s.detach();
      assert.equal(starts.length, 1, mode);
      assert.equal(starts[0]!.capsMode, mode);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
        mode: 'enforce',
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

// Three tools: a plain one, one marked as the Unity MCP server (it has its claude's session too), one started for a person.
// One line: the stand-in host takes a line per command.
const MARKED = `const { spawn } = require('child_process'); const env = (x) => { const e = { ...process.env, ...x }; for (const k of Object.keys(e)) if (e[k] === null) delete e[k]; return e; }; const go = (name, x) => { const p = spawn(process.execPath, ['-e', 'setInterval(() => 0, 1000)'], { stdio: 'ignore', env: env(x) }); console.log(name + ' ' + p.pid); }; go('tool', { FF_SESSION_ID: 'w5766-test' }); go('mcp', { FF_SESSION_ID: 'w5766-test', FF_UNITY_MCP: '1' }); go('person', { FF_SESSION_ID: null, FF_FOR_PERSON: 'w5766-test' }); setInterval(() => 0, 1000);`;

test('w5766: an enforce temp stop ends the tools but spares the Unity MCP server and a program started for a person', { timeout: 180_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-w5766-'));
  const app = appDir();
  try {
    await withHost(async (h) => {
      const hits: CapHit[] = [];
      const logs: string[] = [];
      const stop = await startWorkerCaps({ caps: { memoryBytes: 64 * GiB, processes: 500, tasks: 5000, tempBytes: 1_000_000 }, mode: 'enforce', tempDir: tmp, appDir: app, onCap: (x) => hits.push(x), log: (s) => logs.push(s), hostPid: h.proc.pid, watch: { POLL_MS: 200, TEMP_EVERY_MS: 300 } });
      const pidOf = (name: string) => Number(h.lines.find((l) => l.startsWith(`${name} `))?.split(' ')[1]);
      try {
        h.claude(MARKED);
        const claude = Number((await h.until(/^claude \d+/)).split(' ')[1]);
        assert.ok(await until(() => ['tool', 'mcp', 'person'].every((n) => pidOf(n) > 0), 60_000), JSON.stringify(h.lines));
        // the environments are set before the read (a process's env is fixed at its start)
        await new Promise((r) => setTimeout(r, 1000));
        fs.writeFileSync(path.join(tmp, 'big'), Buffer.alloc(2_000_000));
        const hit = await capHit(hits, 120_000);
        assert.equal(hit.kind, 'temp');
        assert.ok(await until(() => !alive(pidOf('tool')), 10_000), `the plain tool was ended: ${JSON.stringify({ hit, logs })}`);
        assert.equal(alive(pidOf('mcp')), true, `UnityMCP was spared: ${JSON.stringify(logs)}`);
        assert.equal(alive(pidOf('person')), true, "the person's program was spared");
        assert.equal(alive(claude), true);
        assert.equal(alive(h.proc.pid!), true);
        assert.ok(logs.some((l) => /spared 2 process\(es\) of UnityMCP or ff-leftovers launch/.test(l)), JSON.stringify(logs));
      } finally {
        await stop();
        for (const n of ['mcp', 'person']) {
          try {
            process.kill(pidOf(n), 'SIGKILL');
          } catch {
            // gone
          }
        }
      }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('w5766: environments that cannot be read end nothing', { timeout: 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-w5766-'));
  const victim = sleeper();
  try {
    fs.writeFileSync(path.join(tmp, 'big'), Buffer.alloc(2_000_000));
    const hits: CapHit[] = [];
    const logs: string[] = [];
    // the tree path (no job, no scope): the host 7 with its claude 8, and the victim as its tool
    const rows: PsRow[] = [{ pid: 7, ppid: 1, rss: 0, start: 'a' }, { pid: 8, ppid: 7, rss: 0, start: 'a' }, { pid: victim.pid!, ppid: 8, rss: 0, start: 'a' }];
    const stop = await startWorkerCaps({ caps: { memoryBytes: 64 * GiB, processes: 2048, tasks: 5000, tempBytes: 1_000_000 }, mode: 'enforce', platform: 'darwin', hostPid: 7, ps: () => rows, readEnvs: async () => { throw new Error('ps -E failed'); }, tempDir: tmp, appDir: os.tmpdir(), onCap: (x) => hits.push(x), log: (s) => logs.push(s), watch: { POLL_MS: 50, TEMP_EVERY_MS: 100 } });
    const hit = await capHit(hits, 20_000);
    assert.equal(hit.ended, 0);
    assert.equal(alive(victim.pid!), true);
    assert.ok(logs.some((l) => /ended nothing: the tools' environments could not be read.*ps -E failed/.test(l)), JSON.stringify(logs));
    await stop();
  } finally {
    victim.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('w5766: a pid that names another process by the time of the kill is left alone (pid reuse)', { timeout: 60_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-w5766-'));
  const same = sleeper();
  const reused = sleeper();
  try {
    fs.writeFileSync(path.join(tmp, 'big'), Buffer.alloc(2_000_000));
    const hits: CapHit[] = [];
    const logs: string[] = [];
    let reads = 0;
    // every read shows `reused` started again (a new start time: another process got its pid) and `same` unchanged
    const ps = (): PsRow[] => [
      { pid: 7, ppid: 1, rss: 0, start: 'Tue Nov 25 10:00:00 2026' },
      { pid: 8, ppid: 7, rss: 0, start: 'Tue Nov 25 10:00:01 2026' },
      { pid: same.pid!, ppid: 8, rss: 0, start: 'Tue Nov 25 10:01:00 2026' },
      { pid: reused.pid!, ppid: 8, rss: 0, start: `Tue Nov 25 10:02:${String(reads++ % 60).padStart(2, '0')} 2026` },
    ];
    const stop = await startWorkerCaps({ caps: { memoryBytes: 64 * GiB, processes: 2048, tasks: 5000, tempBytes: 1_000_000 }, mode: 'enforce', platform: 'darwin', hostPid: 7, ps, readEnvs: async () => new Map(), tempDir: tmp, appDir: os.tmpdir(), onCap: (x) => hits.push(x), log: (s) => logs.push(s), watch: { POLL_MS: 60_000, TEMP_EVERY_MS: 100 } });
    const hit = await capHit(hits, 20_000);
    assert.equal(hit.ended, 1, JSON.stringify({ hit, logs }));
    assert.ok(await until(() => !alive(same.pid!), 10_000), 'the same process was ended');
    assert.equal(alive(reused.pid!), true, 'the reused pid was not');
    assert.ok(logs.some((l) => /left 1 process\(es\) whose pid now names another process \(pid reuse\)/.test(l)), JSON.stringify(logs));
    await stop();
  } finally {
    same.kill('SIGKILL');
    reused.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Windows: the job refuses a fork bomb past its process cap and the tools are ended', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
  const app = appDir();
  try {
    await withHost(async (h) => {
      const hits: CapHit[] = [];
      const stop = await startWorkerCaps({ caps: { memoryBytes: 64 * GiB, processes: 8, tasks: 0, tempBytes: 1e12 }, mode: 'enforce', appDir: app, onCap: (x) => hits.push(x), log: () => undefined, hostPid: h.proc.pid });
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
      const stop = await startWorkerCaps({ caps: { memoryBytes: 1 * GiB, processes: 100, tasks: 0, tempBytes: 1e12 }, mode: 'enforce', appDir: app, onCap: (x) => hits.push(x), log: () => undefined, hostPid: h.proc.pid });
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
      const stop = await startWorkerCaps({ caps: capsFor(), mode: 'enforce', tempDir: tmp, appDir: app, onCap: (x) => hits.push(x), log: () => undefined, hostPid: h.proc.pid });
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

// ------------------------------------------------------------------------------------------------ the modes (w5554)

async function until(ok: () => boolean, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end && !ok(); await new Promise((r) => setTimeout(r, 100)));
  return ok();
}

/** A fake Linux scope: a folder named like one, holding the cgroup files the watch reads. */
function fakeScope(files: Record<string, string>): { dir: string; set: (f: string, v: string) => void; done: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5554-cg-'));
  // forward slashes: the watch tells a scope by its name after a /, as in /sys/fs/cgroup/...
  const dir = `${root.split(path.sep).join('/')}/ffw-agent-test-1.scope`;
  fs.mkdirSync(dir);
  const set = (f: string, v: string) => fs.writeFileSync(path.join(dir, f), v);
  for (const [f, v] of Object.entries(files)) set(f, v);
  return { dir, set, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => 0, 1000)'], { stdio: 'ignore' });

test('off starts nothing: no job, no watch, no temp stop', { timeout: 120_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-w5554-'));
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'w5554-off-'));
  try {
    await withHost(async (h) => {
      const hits: CapHit[] = [];
      const logs: string[] = [];
      fs.writeFileSync(path.join(tmp, 'big'), Buffer.alloc(2_000_000));
      const stop = await startWorkerCaps({ caps: { memoryBytes: 1, processes: 1, tasks: 1, tempBytes: 1000 }, mode: 'off', tempDir: tmp, appDir: own, onCap: (x) => hits.push(x), log: (s) => logs.push(s), hostPid: h.proc.pid, watch: { POLL_MS: 100, TEMP_EVERY_MS: 100 } });
      try {
        h.claude(SLEEPERS(2));
        await h.until(/^claude \d+/);
        assert.ok(await until(() => h.lines.filter((l) => l.startsWith('tool ')).length === 2));
        await new Promise((r) => setTimeout(r, 1000));
        assert.deepEqual(hits, [], 'caps all over, and nothing said');
        assert.equal(fs.existsSync(path.join(own, 'bin')), false, 'no job helper was even built');
        assert.ok(h.lines.filter((l) => l.startsWith('tool ')).every((l) => alive(Number(l.split(' ')[1]))));
        assert.ok(logs.some((l) => /off/.test(l)));
        assert.equal(
          logs.some((l) => /peaks/.test(l)),
          false,
        );
      } finally {
        await stop();
      }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(own, { recursive: true, force: true });
  }
});

test('warn: a temp folder over its cap is reported once as would-have-hit, and nothing is ended', { timeout: 120_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-w5554-'));
  const app = appDir();
  try {
    await withHost(async (h) => {
      const hits: CapHit[] = [];
      const logs: string[] = [];
      const stop = await startWorkerCaps({ caps: { memoryBytes: 64 * GiB, processes: 500, tasks: 5000, tempBytes: 1_000_000 }, tempDir: tmp, appDir: app, onCap: (x) => hits.push(x), log: (s) => logs.push(s), hostPid: h.proc.pid, watch: { POLL_MS: 200, TEMP_EVERY_MS: 300 } });
      try {
        h.claude(SLEEPERS(2));
        const claude = Number((await h.until(/^claude \d+/)).split(' ')[1]);
        assert.ok(await until(() => h.lines.filter((l) => l.startsWith('tool ')).length === 2, 60_000));
        const tools = h.lines.filter((l) => l.startsWith('tool ')).map((l) => Number(l.split(' ')[1]));
        fs.writeFileSync(path.join(tmp, 'big'), Buffer.alloc(2_000_000));
        const hit = await capHit(hits);
        assert.deepEqual(hit, { kind: 'temp', limit: 1_000_000, seen: 2_000_000, ended: 0, warn: true });
        // more measures follow (every 300 ms), and say nothing more inside REPEAT_MS
        await new Promise((r) => setTimeout(r, 1500));
        assert.equal(hits.length, 1);
        assert.deepEqual([...tools, claude, h.proc.pid!].map(alive), [true, true, true, true], 'nothing was ended');
        assert.ok(logs.some((l) => /would have hit the temp-folder cap.*nothing was stopped/.test(l)));
      } finally {
        await stop();
      }
      assert.ok(
        logs.some((l) => /worker caps: peaks \(mode warn\): .*processes at once.*GB temp/.test(l)),
        JSON.stringify(logs),
      );
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('warn: a tool that starts past the process cap is allowed, counted and reported as would-have-hit', { timeout: 120_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-w5554-'));
  const app = appDir();
  try {
    await withHost(async (h) => {
      const hits: CapHit[] = [];
      const logs: string[] = [];
      // Windows: the job has no limit flags and the helper's `stat` is what says it; elsewhere the tree watch reads ps.
      const stop = await startWorkerCaps({ caps: { memoryBytes: 64 * GiB, processes: 8, tasks: 0, tempBytes: 1e12 }, mode: 'warn', tempDir: tmp, appDir: app, onCap: (x) => hits.push(x), log: (s) => logs.push(s), hostPid: h.proc.pid, watch: { POLL_MS: 200 } });
      try {
        h.claude(SLEEPERS(14));
        const claude = Number((await h.until(/^claude \d+/)).split(' ')[1]);
        assert.ok(await until(() => h.lines.filter((l) => l.startsWith('tool ')).length === 14, 90_000), JSON.stringify(h.lines));
        assert.equal(h.lines.includes('refused'), false, 'no limit: every fork went through');
        const hit = await capHit(hits, 60_000);
        assert.equal(hit.kind, 'processes');
        assert.equal(hit.limit, 8);
        assert.equal(hit.warn, true);
        assert.equal(hit.ended, 0);
        assert.ok((hit.seen ?? 0) > 8, JSON.stringify(hit));
        const tools = h.lines.filter((l) => l.startsWith('tool ')).map((l) => Number(l.split(' ')[1]));
        assert.ok(tools.every(alive), 'nothing was ended');
        assert.equal(alive(claude), true);
        assert.equal(alive(h.proc.pid!), true);
        if (process.platform === 'win32') assert.ok(logs.some((l) => /in a job with no limits \(warn-only\)/.test(l)), JSON.stringify(logs));
      } finally {
        await stop();
      }
      const peak = /peaks \(mode warn\): (\d+) processes at once/.exec(logs.join('\n'));
      assert.ok(peak && Number(peak[1]) > 8, JSON.stringify(logs));
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Windows warn: the job holds no memory limit, its peak commit is polled and reported', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
  const app = appDir();
  await withHost(async (h) => {
    const hits: CapHit[] = [];
    const logs: string[] = [];
    const stop = await startWorkerCaps({ caps: { memoryBytes: 512e6, processes: 500, tasks: 0, tempBytes: 1e12 }, mode: 'warn', appDir: app, onCap: (x) => hits.push(x), log: (s) => logs.push(s), hostPid: h.proc.pid, watch: { POLL_MS: 200 } });
    try {
      // a tool that holds 700 MB: over the 512 MB cap, which in enforce mode refuses it
      h.claude(
        `const { spawn } = require('child_process'); const p = spawn(process.execPath, ['-e', "const a = Buffer.alloc(700e6, 1); console.log(a.length > 0 ? 'got it' : ''); setInterval(() => 0, 1000)"], { stdio: ['ignore', 'inherit', 'ignore'] }); console.log('tool ' + p.pid); setInterval(() => 0, 1000);`,
      );
      const claude = Number((await h.until(/^claude \d+/)).split(' ')[1]);
      await h.until(/^got it$/, 60_000);
      const hit = await capHit(hits, 60_000);
      assert.equal(hit.kind, 'memory');
      assert.equal(hit.warn, true);
      assert.equal(hit.ended, 0);
      assert.ok((hit.seen ?? 0) > 512e6, JSON.stringify(hit));
      assert.equal(alive(claude), true);
    } finally {
      await stop();
    }
    assert.ok(
      logs.some((l) => /peaks \(mode warn\): .*, (?!0\.0 )\d+\.\d GB memory/.test(l)),
      JSON.stringify(logs),
    );
  });
});

// Git Bash, where a worker runs most of its tools: the one Claude Code uses (a worker's, its own Git), else Git for Windows';
// absent on a runner without either. One that exists but cannot start here is skipped too (w5766, from w5719's review: in a
// worker, a second MSYS runtime in one session died with NtCreateDirectoryObject 0xC0000022, and the test failed on its 60 s
// wait instead of skipping).
const gitBash = (candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')]): string | undefined => {
  if (process.platform !== 'win32') return undefined;
  const bash = candidates.find((b): b is string => !!b && fs.existsSync(b));
  if (!bash) return undefined;
  const r = spawnSync(bash, ['-c', 'echo ok'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  return r.status === 0 && r.stdout.trim() === 'ok' ? bash : undefined;
};
const GIT_BASH = gitBash();

test('the Git Bash probe skips one that exists but cannot run `echo ok` (w5766)', { skip: process.platform !== 'win32' }, () => {
  // node exists and starts, but `node -c "echo ok"` checks a script that is not there: not a working bash.
  assert.equal(gitBash([process.execPath]), undefined, 'a bash that cannot start is no Git Bash');
  assert.equal(gitBash([path.join(os.tmpdir(), 'no-such-bash.exe')]), undefined, 'a missing one is none either');
});

test("Windows warn: what Git Bash starts stays in the job and is counted (no breakaway)", { skip: !GIT_BASH, timeout: 120_000 }, async () => {
  const app = appDir();
  await withHost(async (h) => {
    const logs: string[] = [];
    const stop = await startWorkerCaps({ caps: { memoryBytes: 64 * GiB, processes: 1000, tasks: 0, tempBytes: 1e12 }, mode: 'warn', appDir: app, onCap: () => undefined, log: (s) => logs.push(s), hostPid: h.proc.pid, watch: { POLL_MS: 200 } });
    try {
      // the tool is Bash, which starts six sleeps: with JOB_OBJECT_LIMIT_BREAKAWAY_OK MSYS starts them outside the job
      h.claude(`const { spawn } = require('child_process'); const p = spawn(${JSON.stringify(GIT_BASH)}, ['-c', 'for i in 1 2 3 4 5 6; do sleep 30 & done; echo started; wait'], { stdio: ['ignore', 'inherit', 'ignore'] }); console.log('tool ' + p.pid); setInterval(() => 0, 1000);`);
      await h.until(/^started$/, 60_000);
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      await stop();
    }
    // host, claude, bash and six sleeps: nine at least (only three when the sleeps broke away)
    const peak = /peaks \(mode warn\): (\d+) processes at once/.exec(logs.join('\n'));
    assert.ok(peak && Number(peak[1]) >= 9, JSON.stringify(logs));
  });
});

test('Linux warn: the scope has no limits; its anonymous memory and pids.peak are read and reported over the caps, once', { timeout: 60_000 }, async () => {
  // memory.peak counts page cache (a worker that read a big clone looked full): w5766 reads memory.stat's anon instead
  const cg = fakeScope({ 'memory.stat': 'anon 1000000000\nfile 50000000000\n', 'memory.peak': '60000000000\n', 'pids.peak': '5\n', 'memory.events.local': 'oom_kill 0\n', 'pids.events': 'max 0\n' });
  try {
    const hits: CapHit[] = [];
    const logs: string[] = [];
    const stop = await startWorkerCaps({ caps: { memoryBytes: 8e9, processes: 2048, tasks: 10, tempBytes: 1e12 }, platform: 'linux', cgroup: cg.dir, appDir: os.tmpdir(), onCap: (x) => hits.push(x), log: (s) => logs.push(s), watch: { POLL_MS: 50 } });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hits.length, 0, 'under the caps');
    cg.set('memory.stat', 'anon 9000000000\nfile 50000000000\n');
    cg.set('pids.peak', '50\n');
    assert.ok(await until(() => hits.length === 2, 10_000), JSON.stringify(hits));
    assert.deepEqual(hits.find((x) => x.kind === 'memory'), { kind: 'memory', limit: 8e9, seen: 9e9, ended: 0, warn: true });
    assert.deepEqual(hits.find((x) => x.kind === 'processes'), { kind: 'processes', limit: 10, seen: 50, ended: 0, warn: true });
    cg.set('memory.stat', 'anon 12000000000\nfile 50000000000\n');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(hits.length, 2, 'once per kind per REPEAT_MS');
    await stop();
    assert.ok(
      logs.some((l) => l.includes('peaks (mode warn): 50 tasks at once (cap 10), 12.0 GB memory (cap 8.0 GB)')),
      JSON.stringify(logs),
    );
    assert.ok(logs.some((l) => /no limits: warn-only/.test(l)));
  } finally {
    cg.done();
  }
});

test('Linux warn: an older kernel without memory.stat or *.peak is read from memory.current and pids.current', { timeout: 60_000 }, async () => {
  const cg = fakeScope({ 'memory.current': '9000000000\n', 'pids.current': '3\n' });
  try {
    const hits: CapHit[] = [];
    const stop = await startWorkerCaps({ caps: { memoryBytes: 8e9, processes: 2048, tasks: 10, tempBytes: 1e12 }, platform: 'linux', cgroup: cg.dir, appDir: os.tmpdir(), onCap: (x) => hits.push(x), log: () => undefined, watch: { POLL_MS: 50 } });
    assert.ok(await until(() => hits.length === 1, 10_000));
    assert.equal(hits[0].kind, 'memory');
    assert.equal(hits[0].warn, true);
    await stop();
  } finally {
    cg.done();
  }
});

test('Linux enforce: the kernel acting is reported and nothing is ended by us, whatever is in the scope', { timeout: 60_000 }, async () => {
  const victim = sleeper();
  const cg = fakeScope({ 'memory.events.local': 'oom_kill 0\n', 'pids.events': 'max 0\n', 'cgroup.procs': `${victim.pid}\n` });
  try {
    const hits: CapHit[] = [];
    const stop = await startWorkerCaps({ caps: { memoryBytes: 8e9, processes: 2048, tasks: 10, tempBytes: 1e12 }, mode: 'enforce', platform: 'linux', cgroup: cg.dir, hostPid: 2_000_000_000, appDir: os.tmpdir(), onCap: (x) => hits.push(x), log: () => undefined, watch: { POLL_MS: 50 } });
    await new Promise((r) => setTimeout(r, 300));
    cg.set('memory.events.local', 'oom_kill 1\n');
    cg.set('pids.events', 'max 4\n');
    assert.ok(await until(() => hits.length === 2, 10_000), JSON.stringify(hits));
    assert.deepEqual(hits.find((x) => x.kind === 'memory'), { kind: 'memory', limit: 8e9, ended: 0, kernel: true });
    assert.deepEqual(hits.find((x) => x.kind === 'processes'), { kind: 'processes', limit: 10, ended: 0, kernel: true });
    assert.equal(alive(victim.pid!), true);
    await stop();
  } finally {
    victim.kill('SIGKILL');
    cg.done();
  }
});

test('enforce: a process list without the host ends nothing, and says why', { timeout: 60_000 }, async () => {
  // A temp hit on a scope's cgroup.procs (which lists this victim) with a host pid no `ps` knows: the list cannot say which
  // process is its claude, so nothing is ended (no `ps` at all, as on a bare Windows, is the same: an empty list).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-w5554-'));
  const victim = sleeper();
  const cg = fakeScope({ 'memory.events.local': 'oom_kill 0\n', 'pids.events': 'max 0\n', 'cgroup.procs': `${victim.pid}\n` });
  try {
    fs.writeFileSync(path.join(tmp, 'big'), Buffer.alloc(2_000_000));
    const hits: CapHit[] = [];
    const logs: string[] = [];
    const stop = await startWorkerCaps({ caps: { memoryBytes: 64 * GiB, processes: 2048, tasks: 5000, tempBytes: 1_000_000 }, mode: 'enforce', platform: 'linux', cgroup: cg.dir, hostPid: 2_000_000_000, tempDir: tmp, appDir: os.tmpdir(), onCap: (x) => hits.push(x), log: (s) => logs.push(s), watch: { POLL_MS: 50 } });
    const hit = await capHit(hits, 20_000);
    assert.equal(hit.kind, 'temp');
    assert.equal(hit.ended, 0);
    assert.equal(hit.warn, undefined, 'enforce said it, with nothing ended');
    assert.equal(alive(victim.pid!), true);
    assert.ok(
      logs.some((l) => /ended nothing: the (process list was empty|host \(pid 2000000000\) is not in the process list)/.test(l)),
      JSON.stringify(logs),
    );
    await stop();
  } finally {
    victim.kill('SIGKILL');
    cg.done();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
