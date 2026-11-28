// w799: an agent host's end. On BEAST (2026-10-09) the daemon dropped two hosts whose processes still ran (their
// heartbeats were 30 s late under load), never ended their trees, and could not remove their folders (EPERM: Windows
// refuses to delete a folder a live process works in); one ran on for half an hour, its tool calls unanswered, while its
// sandbox went to a new worker. These tests run real processes standing in for hosts: a node that works in the host
// folder (as the real host did, its cwd) and starts a child of its own (as a host starts claude.exe and the Unity MCP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { HostedSession, cpuSince, hostFiles, hostFolders, hostLook, pidAlive, HOST_PROTOCOL, type HostDeps } from '../machine/agentHost.ts';
import { HOST_WATCH, HostWatch, folderLastWrite, lingeringRefusal, realHostProcs, removeHostDir, sameHost, waitGone, type LingeringHost } from '../machine/hostWatch.ts';
import type { FromDaemon } from './machineProtocol.ts';
import type { SessionInfo } from '../shared/types.ts';

const until = async (what: string, cond: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** The time in a host's daemon.progress, 0 while it is missing or mid-write (an async writeFile truncates first: w6606). */
const savedProgress = (dir: string) => {
  try {
    return Number(fs.readFileSync(hostFiles(dir).progress, 'utf8')) || 0;
  } catch {
    return 0;
  }
};

const info = (id: string): SessionInfo => ({ id, kind: 'worker', title: `w799 ${id}`, status: 'running', permissionMode: 'default', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), turns: 1, costUsd: 0, pendingPermissions: [] });

/**
 * A stand-in host in `dir`: a node working in that folder, with a child working there too, and the host's files
 * (host.json with its pid and start time; a heartbeat `staleSec` old). Returns the two processes' pids.
 */
async function fakeHost(dir: string, o: { staleSec?: number; recordStart?: string; state?: boolean } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000)";
  const host: ChildProcess = spawn(process.execPath, ['-e', script], { cwd: dir, stdio: 'ignore', windowsHide: true });
  const f = hostFiles(dir);
  fs.writeFileSync(f.host, JSON.stringify({ hostProtocol: HOST_PROTOCOL, sessionId: path.basename(dir), pid: host.pid, startedAt: o.recordStart ?? new Date().toISOString() }));
  await until('the stand-in host started its child', () => fs.existsSync(path.join(dir, 'child.pid')) && Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8')) > 0);
  const child = Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8'));
  beat(dir, o.staleSec ?? 0);
  if (o.state !== false) fs.writeFileSync(f.state, JSON.stringify({ op: 'state', info: info(path.basename(dir)), live: true, lastFrom: 'orchestrator' }));
  fs.writeFileSync(f.place, JSON.stringify({ cwd: dir, sandbox: 'slot1' }));
  return { pid: host.pid!, child };
}

/** Write the heartbeat, `ageSec` old. */
function beat(dir: string, ageSec: number) {
  const f = hostFiles(dir);
  fs.writeFileSync(f.beat, String(Date.now()));
  const at = new Date(Date.now() - ageSec * 1000);
  fs.utimesSync(f.beat, at, at);
}

/** End the stand-in processes, wait until they are gone, then remove the test's folder (it is their cwd: Windows holds it until then). */
async function cleanUp(root: string, ...pids: number[]) {
  for (const p of pids) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // gone
    }
  }
  for (const p of pids) await waitGone(realHostProcs(), p, 10_000);
  assert.equal(await removeHostDir(root), undefined);
}

function hostedOn(root: string, id: string, extra: Partial<HostDeps> = {}) {
  const out: FromDaemon[] = [];
  const logs: string[] = [];
  const stopping: boolean[] = [];
  const deps: HostDeps = {
    root,
    out: (m) => out.push(m),
    events: new EventEmitter(),
    handlers: () => ({}),
    spec: () => ({ cwd: root }) as never,
    editorUp: () => undefined,
    changed: () => undefined,
    log: (l) => logs.push(l),
    launch: () => {
      throw new Error('no new host in this test');
    },
    stopping: (_s, on) => stopping.push(on),
    ...extra,
  };
  const s = new HostedSession(info(id), 0, deps);
  return { s, out, logs, stopping, deps };
}

test('w799: Windows locked folder: a live host holds its folder, so the host is ended, tree and all, before its folder goes', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w799-locked-'));
  const dir = path.join(root, 'a1');
  const { pid, child } = await fakeHost(dir, { staleSec: 60 });
  t.after(() => cleanUp(root, pid, child));
  if (process.platform === 'win32') {
    // The case itself, on Windows: the folder cannot go (or even move) while a process works in it.
    assert.throws(() => fs.renameSync(dir, `${dir}-moved`), (e: NodeJS.ErrnoException) => ['EPERM', 'EBUSY', 'EACCES'].includes(e.code ?? ''), 'Windows holds a folder a live process works in');
  }
  // Silent past hungMs (its heartbeat 60 s old), its process alive: stopped, and only then its folder removed.
  const h = hostedOn(root, 'a1', { hungMs: 1 });
  assert.equal(hostLook(dir), 'stale');
  assert.equal(h.s.adopt(), true, 'a host whose process runs is taken back, late heartbeat or not');
  await until('its folder removed', () => !fs.existsSync(dir));
  assert.equal(pidAlive(pid), false, 'the host was ended');
  assert.equal(pidAlive(child), false, 'and what it started (its claude.exe, the Unity MCP chain)');
  assert.ok(h.logs.some((l) => /ended its process tree \(pid \d+\)/.test(l)), h.logs.join('\n'));
  assert.ok(!h.logs.some((l) => /could not remove/.test(l)), `no folder left behind:\n${h.logs.join('\n')}`);
  const ended = h.out.filter((m) => m.type === 'session').at(-1) as Extract<FromDaemon, { type: 'session' }>;
  assert.equal(ended.live, false);
  assert.match(ended.info.statusDetail ?? '', /gave no heartbeat for \d+ min while its process ran: stopped/);
  assert.deepEqual(h.stopping, [true, false], 'its sandbox was marked taken while the tree was stopped, then freed');
});

test('w799: a host whose heartbeat is late while its process runs is kept and read on, never dropped (the BEAST 2026-10-09 trigger)', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w799-stale-'));
  const dir = path.join(root, 'b1');
  const { pid, child } = await fakeHost(dir, { staleSec: 60 });
  const answered: string[] = [];
  const h = hostedOn(root, 'b1', {
    hungMs: 10 * 60_000,
    // A handler that throws at once: the call is still answered (w799: an rpc must never hang its agent).
    handlers: () => ({
      publish_attachment: () => {
        throw new Error('boom: no such file');
      },
      read_work: async () => {
        answered.push('read_work');
        return 'ok';
      },
    }),
  });
  t.after(async () => {
    h.s.detach();
    await cleanUp(root, pid, child);
  });
  assert.equal(h.s.adopt(), true);
  // Two liveness looks (one every 2 s): the old daemon dropped it at the first.
  await new Promise((r) => setTimeout(r, 4_500));
  assert.ok(fs.existsSync(dir), 'its folder stays');
  assert.equal(pidAlive(pid), true, 'its process runs on');
  assert.ok(!h.out.some((m) => m.type === 'session' && !m.live), 'not reported ended');
  assert.ok(h.logs.some((l) => /no heartbeat for 30 s, but its process \(pid \d+\) still runs: kept/.test(l)), h.logs.join('\n'));
  // Still read: its tool calls are answered, one whose handler throws at once included.
  const f = hostFiles(dir);
  fs.appendFileSync(f.out, JSON.stringify({ op: 'rpc', id: 'r1', method: 'publish_attachment', args: { file: 'probe.bin' } }) + '\n');
  fs.appendFileSync(f.out, JSON.stringify({ op: 'rpc', id: 'r2', method: 'read_work', args: {} }) + '\n');
  const results = () =>
    fs
      .readFileSync(f.in, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { op: string; id?: string; ok?: boolean; text?: string })
      .filter((c) => c.op === 'rpc_result');
  await until('both calls answered', () => results().length === 2);
  const byId = Object.fromEntries(results().map((r) => [r.id, r]));
  assert.equal(byId.r1.ok, false, 'a handler that threw: answered with its failure');
  assert.match(byId.r1.text!, /boom: no such file/);
  assert.equal(byId.r2.ok, true);
  assert.deepEqual(answered, ['read_work']);
  // Its heartbeat comes back: noted, and nothing else happens.
  beat(dir, 0);
  await until('the heartbeat noticed', () => h.logs.some((l) => /its heartbeat is back after \d+ s/.test(l)), 10_000);
  assert.ok(fs.existsSync(dir));
});

test('w799: orphaned host: one whose session nobody follows is flagged and stopped on the second look; followed, reused-pid and recent gone ones are left', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w799-orphan-'));
  const orphan = await fakeHost(path.join(root, 'orphan1'));
  const kept = await fakeHost(path.join(root, 'kept1'));
  // A pid that now belongs to another program: its record says it started a day ago.
  const reused = await fakeHost(path.join(root, 'reused1'), { recordStart: new Date(Date.now() - 24 * 3600_000).toISOString() });
  // Hosts long gone: one past the sweep delay, one recent (kept for a post-mortem).
  for (const [name, ageMs] of [
    ['gone-old', HOST_WATCH.SWEEP_AFTER_MS + 60_000],
    ['gone-new', 60_000],
  ] as const) {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    fs.writeFileSync(hostFiles(d).host, JSON.stringify({ hostProtocol: HOST_PROTOCOL, sessionId: name, pid: 2 ** 22 + 12345, startedAt: new Date().toISOString() }));
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(hostFiles(d).host, at, at);
    fs.utimesSync(d, at, at);
  }
  t.after(() => cleanUp(root, ...[orphan, kept, reused].flatMap((x) => [x.pid, x.child])));
  const events: { text: string; sandbox?: string }[] = [];
  const lingering: [LingeringHost, boolean][] = [];
  const watch = new HostWatch({
    procs: realHostProcs(),
    folders: () => hostFolders(root),
    protocol: HOST_PROTOCOL,
    followed: (id) => id === 'kept1',
    sandboxOf: (dir) => (JSON.parse(fs.readFileSync(hostFiles(dir).place, 'utf8')) as { sandbox?: string }).sandbox,
    lastWrite: folderLastWrite,
    removeDir: (dir) => removeHostDir(dir),
    lingering: (l, on) => lingering.push([l, on]),
    log: () => undefined,
    event: (text, sandbox) => events.push({ text, ...(sandbox ? { sandbox } : {}) }),
    now: () => Date.now(),
  });
  const first = await watch.tick();
  assert.equal(pidAlive(orphan.pid), true, 'one look is not enough: a session may be starting or being taken back');
  assert.deepEqual(first, [`agent host gone-old: removed its folder (its host is gone)`]);
  const second = await watch.tick();
  assert.equal(second.length, 1, second.join('\n'));
  assert.equal(pidAlive(orphan.pid), false, 'the orphan was stopped');
  assert.equal(pidAlive(orphan.child), false, 'with its tree');
  assert.equal(fs.existsSync(path.join(root, 'orphan1')), false, 'and its folder removed');
  assert.equal(events.length, 1);
  assert.equal(events[0].sandbox, 'slot1');
  assert.match(events[0].text, /^Agent host orphan1 \(pid \d+\) in sandbox slot1 still ran after this machine's daemon had dropped its session .*ended its process tree .*removed its folder\.$/);
  assert.deepEqual(
    lingering.map(([l, on]) => [l.sessionId, l.sandbox, on]),
    [
      ['orphan1', 'slot1', true],
      ['orphan1', 'slot1', false],
    ],
    'its sandbox counted taken while it was stopped',
  );
  assert.equal(pidAlive(kept.pid), true, 'a followed host is never the watch’s');
  assert.equal(pidAlive(reused.pid), true, 'a pid that is another program now is never killed');
  assert.ok(fs.existsSync(path.join(root, 'reused1')) && fs.existsSync(path.join(root, 'gone-new')), 'recent folders of gone hosts stay');
  assert.equal(fs.existsSync(path.join(root, 'gone-old')), false);
});

test('w799: slot reuse guard: no new agent starts in a sandbox where another session’s old host is still being stopped', () => {
  const l: LingeringHost[] = [{ sessionId: '38a203f0', pid: 43380, sandbox: 'slot1', since: '2026-10-09T20:01:56Z' }];
  assert.match(lingeringRefusal('slot1', '6cc70ea1', l) ?? '', /the agent host of session 38a203f0 \(pid 43380\) that worked in sandbox slot1 is still being stopped/);
  assert.equal(lingeringRefusal('slot1', '38a203f0', l), undefined, 'its own session waits for it instead (its message is held until the tree is gone)');
  assert.equal(lingeringRefusal('slot2', '6cc70ea1', l), undefined, 'another sandbox is not held');
  assert.equal(lingeringRefusal(undefined, '6cc70ea1', l), undefined, 'a standing agent has no sandbox');
});

test('w799: a host is its pid and start time: a record written within seconds of the process starting, never before', () => {
  const t0 = Date.parse('2026-10-09T19:52:15.206Z'); // 38a203f0's host.json
  assert.equal(sameHost('2026-10-09T19:52:15.206Z', t0 - 300), true, 'node starts, then writes its record');
  assert.equal(sameHost('2026-10-09T19:52:15.206Z', t0 - 45_000), true, 'a slow start on a loaded machine');
  assert.equal(sameHost('2026-10-09T19:52:15.206Z', t0 + 3_600_000), false, 'a process started an hour later reused the pid');
  assert.equal(sameHost('2026-10-09T19:52:15.206Z', t0 - 3_600_000), false, 'one an hour older is not it either');
  assert.equal(sameHost('not a time', t0), false);
});

test('w799: a host folder Windows still holds is removed by retrying (EPERM, EBUSY), not given up on at the first refusal', async () => {
  let calls = 0;
  const waits: number[] = [];
  const flaky = (code: string, failures: number) => () => {
    calls++;
    if (calls <= failures) throw Object.assign(new Error(`${code}, Permission denied: \\\\?\\F:\\ffw\\daemon\\hosts\\38a203f0`), { code });
  };
  assert.equal(await removeHostDir('x', { rm: flaky('EPERM', 3), sleep: async (ms) => void waits.push(ms) }), undefined);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [250, 500, 1000], 'backing off');
  calls = 0;
  assert.match((await removeHostDir('x', { rm: flaky('EBUSY', 99), sleep: async () => undefined, tries: 3 }))!, /EBUSY/, 'it gives up in the end, saying why');
  assert.equal(calls, 3);
  calls = 0;
  assert.match((await removeHostDir('x', { rm: flaky('EINVAL', 99), sleep: async () => undefined }))!, /EINVAL/, 'other errors are not retried');
  assert.equal(calls, 1);
});

// w3673: worker 316ded29 (lothdesktop, 2026-11-07) sat mid-turn for 12 h without a tool call or a transcript line while
// its host's heartbeat ran on; ten daemons adopted it "running, live" and nothing looked at its progress. The hang watch
// reads its tools' CPU after SILENT_MS without progress and LOOK_MS later: idle tools end its tree (the portal resumes
// it), busy ones (a long build, a timed run) keep it.
const lastSession = (h: ReturnType<typeof hostedOn>) => h.out.filter((m) => m.type === 'session').at(-1) as Extract<FromDaemon, { type: 'session' }> | undefined;

test('w3673: cpuSince sums what each process used between two reads, a new process in full', () => {
  const before = new Map([['1@a', 1000], ['2@b', 500]]);
  const after = new Map([['1@a', 4000], ['2@b', 400], ['3@c', 250]]);
  assert.equal(cpuSince(before, after), 3000 + 0 + 250);
});

test('w3673: an agent silent mid-turn whose tools are idle is flagged, then its host tree is ended so it is resumed', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w3673-idle-'));
  const dir = path.join(root, 'h1');
  const { pid, child } = await fakeHost(dir);
  t.after(() => cleanUp(root, pid, child));
  const reads: number[] = [];
  const h = hostedOn(root, 'h1', {
    hang: { SILENT_MS: 1, LOOK_MS: 1_000, BUSY_CPU_MS: 30_000 },
    // A wait loop's CPU: about nothing between the two looks.
    toolsCpu: async (p) => (reads.push(p), new Map([['9@x', 1_200 + reads.length]])),
  });
  assert.equal(h.s.adopt(), true);
  await until('its folder removed', () => !fs.existsSync(dir));
  assert.equal(pidAlive(pid), false, 'the host was ended');
  assert.equal(pidAlive(child), false, 'and its tree');
  assert.ok(reads.length >= 2 && reads.every((p) => p === pid), `its tools' CPU was read twice under its host: ${reads.join(',')}`);
  assert.ok(h.logs.some((l) => /hang watch reads its tools' CPU/.test(l)), h.logs.join('\n'));
  const ended = lastSession(h)!;
  assert.equal(ended.live, false);
  assert.match(ended.info.statusDetail ?? '', /^its agent host made no progress for \d+ min mid-turn .*its tools used 0\.0 s of CPU/);
  assert.ok(h.logs.some((l) => /its agent looks hung/.test(l)), h.logs.join('\n'));
});

test('w3673: busy tools keep a silent agent (a long build), flagged; progress clears the flag', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w3673-busy-'));
  const dir = path.join(root, 'h2');
  const { pid, child } = await fakeHost(dir);
  let used = 0;
  const h = hostedOn(root, 'h2', {
    hang: { SILENT_MS: 1, LOOK_MS: 500, BUSY_CPU_MS: 30_000 },
    // A build: a minute of CPU between every two reads.
    toolsCpu: async () => new Map([['9@x', (used += 60_000)]]),
  });
  t.after(async () => {
    h.s.detach();
    await cleanUp(root, pid, child);
  });
  assert.equal(h.s.adopt(), true);
  await until('kept as busy', () => /its tools are at work \(60\.0 s of CPU/.test(lastSession(h)?.info.statusDetail ?? ''));
  assert.ok(fs.existsSync(dir) && pidAlive(pid), 'its host runs on');
  assert.ok(!h.out.some((m) => m.type === 'session' && !m.live), 'never ended');
  // Its agent says something: the flag goes and the clock starts again.
  h.deps.hang = { SILENT_MS: 60 * 60_000 };
  fs.appendFileSync(hostFiles(dir).out, JSON.stringify({ op: 'delta', text: 'back' }) + '\n');
  await until('the flag cleared', () => lastSession(h)?.info.statusDetail === undefined);
  assert.ok(h.logs.some((l) => /made progress again/.test(l)), h.logs.join('\n'));
  // w6606: daemon.progress is written off the loop (w6554), so the flag can clear before the write lands: wait for it
  await until('its progress time kept for the next daemon', () => savedProgress(dir) > Date.now() - 60_000);
});

test('w6110: idle tools that run lowered below a CI job keep a silent agent, flagged, rather than end it', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w6110-lowered-'));
  const dir = path.join(root, 'h6');
  const { pid, child } = await fakeHost(dir);
  const h = hostedOn(root, 'h6', {
    hang: { SILENT_MS: 1, LOOK_MS: 500, BUSY_CPU_MS: 30_000 },
    toolsCpu: async () => new Map([['9@x', 1_200]]),
    toolsLowered: (p) => p === pid,
  });
  t.after(async () => {
    h.s.detach();
    await cleanUp(root, pid, child);
  });
  assert.equal(h.s.adopt(), true);
  await until('kept as lowered', () => /they run lowered below a CI job \(w6110\)/.test(lastSession(h)?.info.statusDetail ?? ''));
  assert.ok(fs.existsSync(dir) && pidAlive(pid), 'its host runs on');
  assert.ok(!h.out.some((m) => m.type === 'session' && !m.live), 'never ended');
});

test('w3673: the hang watch\'s clock goes on across daemons (daemon.progress), and a message held mid-turn does not reset it', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w3673-adopt-'));
  const dir = path.join(root, 'h3');
  const { pid, child } = await fakeHost(dir);
  // The daemon before this one last saw progress 40 min ago; out.jsonl is newer (state lines), which is no progress.
  fs.writeFileSync(hostFiles(dir).progress, String(Date.now() - 40 * 60_000));
  fs.writeFileSync(hostFiles(dir).out, JSON.stringify({ op: 'state', info: info('h3'), live: true }) + '\n');
  const h = hostedOn(root, 'h3', { hang: { SILENT_MS: 30 * 60_000, LOOK_MS: 60 * 60_000 }, toolsCpu: async () => new Map() });
  t.after(async () => {
    h.s.detach();
    await cleanUp(root, pid, child);
  });
  assert.equal(h.s.adopt(), true);
  // A follow-up arrives mid-turn and is held (the 12:30 follow-up, the disk notices, the 15:00 interrupt in 316ded29).
  h.s.send('a follow-up held mid-turn', 'orchestrator');
  await until('flagged from the saved clock', () => /no progress from its agent for 4\d min mid-turn/.test(lastSession(h)?.info.statusDetail ?? ''), 10_000);
});

test('w6486: the poll saves its offset off the event loop, and a going daemon\'s save outlasts a slow write that lands after it', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w6486-offset-'));
  const dir = path.join(root, 'o1');
  const { pid, child } = await fakeHost(dir);
  const answered: string[] = [];
  const handlers = () => ({ read_work: async (args: unknown) => (answered.push(String((args as { n: string }).n)), 'ok') });
  const f = hostFiles(dir);
  const call = (n: string) => fs.appendFileSync(f.out, JSON.stringify({ op: 'rpc', id: n, method: 'read_work', args: { n } }) + '\n');
  const size = () => fs.statSync(f.out).size;
  // The offset file is made by the first poll's write: until then it is not there.
  const saved = (p: string) => (fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : NaN);
  const first = hostedOn(root, 'o1', { handlers });
  let second: ReturnType<typeof hostedOn> | undefined;
  t.after(async () => {
    first.s.detach();
    second?.s.detach();
    await cleanUp(root, pid, child);
  });
  assert.equal(first.s.adopt(), true);
  call('r1');
  await until('r1 answered and its offset saved by the poll', () => answered.includes('r1') && saved(f.offset) === size());
  assert.equal(fs.existsSync(f.offsetStop), false, 'no stop file while no write races the going daemon');

  // A slow disk (BEAST: 6-10 s a write): the poll's next write is held until after the daemon has gone.
  const open = fs.promises.open;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let slow = 0;
  t.mock.method(fs.promises, 'open', async (...a: Parameters<typeof open>) => {
    if (String(a[0]) === f.offset) {
      slow++;
      await held;
    }
    return open(...a);
  });
  call('r2');
  await until('r2 answered while its offset write is held', () => answered.includes('r2') && slow === 1);
  call('r3');
  await until('r3 answered, read while the write is still held', () => answered.includes('r3'));
  const end = size();
  first.s.detach();
  assert.equal(saved(f.offset), end, 'the going daemon saves what it read, at once');
  assert.equal(saved(f.offsetStop), end, 'and in the stop file, since a write still races it');
  release();
  await until('the held write landed, older', () => saved(f.offset) < end);
  t.mock.restoreAll();

  // The next daemon forwards exactly what the last one had not: r4 only.
  answered.length = 0;
  second = hostedOn(root, 'o1', { handlers });
  assert.equal(second.s.adopt(), true);
  call('r4');
  await until('r4 answered', () => answered.includes('r4'));
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(answered, ['r4'], 'nothing forwarded twice');
});

test('w6519: an older, shorter offset that lands on the going daemon\'s longer one never leaves a larger number, whenever the daemon exits', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w6519-width-'));
  const dir = path.join(root, 'o4');
  const { pid, child } = await fakeHost(dir);
  const answered: string[] = [];
  const handlers = () => ({ read_work: async (args: unknown) => (answered.push(String((args as { n: string }).n)), 'ok') });
  const f = hostFiles(dir);
  const call = (n: string, pad = '') => fs.appendFileSync(f.out, JSON.stringify({ op: 'rpc', id: n, method: 'read_work', args: { n, pad } }) + '\n');
  const size = () => fs.statSync(f.out).size;
  const saved = (p: string) => (fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : NaN);
  const first = hostedOn(root, 'o4', { handlers });
  let second: ReturnType<typeof hostedOn> | undefined;
  t.after(async () => {
    t.mock.restoreAll();
    first.s.detach();
    second?.s.detach();
    await cleanUp(root, pid, child);
  });
  assert.equal(first.s.adopt(), true);
  call('r1');
  await until('r1 answered and its offset saved', () => answered.includes('r1') && saved(f.offset) === size());

  // The poll's next write (3 digits) is held; meanwhile the daemon reads past 1000 (4 digits) and goes. The held write
  // then lands, and the daemon exits before anything after the write: a truncate that never comes (w6519 on BEAST).
  const open = fs.promises.open;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let slow = 0;
  let wrote = 0;
  t.mock.method(fs.promises, 'open', async (...a: Parameters<typeof open>) => {
    if (String(a[0]) !== f.offset) return open(...a);
    slow++;
    await held;
    const file = await open(...a);
    return new Proxy(file, {
      get(target, key) {
        if (key === 'truncate') return () => new Promise(() => {});
        const v = Reflect.get(target, key, target);
        if (key === 'write') return async (...w: unknown[]) => ((await (v as (...x: unknown[]) => Promise<unknown>).apply(target, w)), wrote++);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  });
  call('r2');
  await until('r2 answered while its offset write is held', () => answered.includes('r2') && slow === 1);
  call('r3', 'x'.repeat(1000));
  await until('r3 answered', () => answered.includes('r3'));
  const end = size();
  assert.ok(end >= 1000, `read past 1000 (${end})`);
  first.s.detach();
  release();
  await until('the held, older write landed', () => wrote === 1);
  const next = Math.max(saved(f.offset) || 0, saved(f.offsetStop) || 0);
  assert.equal(next, end, `the next daemon reads from where the going one stopped (${end}); daemon.offset holds ${JSON.stringify(fs.readFileSync(f.offset, 'utf8'))}`);
  t.mock.restoreAll();

  // And so it does: r4 only.
  answered.length = 0;
  second = hostedOn(root, 'o4', { handlers });
  assert.equal(second.s.adopt(), true);
  call('r4');
  await until('r4 answered', () => answered.includes('r4'));
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(answered, ['r4'], 'nothing forwarded twice');
});

test('w6486: a failed offset write is tried again by the next poll',{ timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w6486-retry-'));
  const dir = path.join(root, 'o2');
  const { pid, child } = await fakeHost(dir);
  const f = hostFiles(dir);
  const h = hostedOn(root, 'o2');
  t.after(async () => {
    h.s.detach();
    await cleanUp(root, pid, child);
  });
  const open = fs.promises.open;
  let fails = 2;
  t.mock.method(fs.promises, 'open', async (...a: Parameters<typeof open>) => {
    if (String(a[0]) === f.offset && fails > 0) {
      fails--;
      throw Object.assign(new Error('EBUSY: a scanner holds it'), { code: 'EBUSY' });
    }
    return open(...a);
  });
  assert.equal(h.s.adopt(), true);
  fs.appendFileSync(f.out, JSON.stringify({ op: 'beat' }) + '\n');
  const size = fs.statSync(f.out).size;
  await until('saved once the disk lets it', () => fails === 0 && fs.existsSync(f.offset) && Number(fs.readFileSync(f.offset, 'utf8')) === size);
});

test('w6508: a poll write of an earlier start that lands after a new start never puts the old offset over the new one', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w6508-restart-'));
  const dir = path.join(root, 'o3');
  const f = hostFiles(dir);
  const saved = (p: string) => (fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : NaN);
  // A host for each start: a node working elsewhere, so the folder stays free for start() to remove (on Windows a
  // process working in it would hold it).
  const pids: number[] = [];
  const h = hostedOn(root, 'o3', {
    launch: () => {
      const p = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, stdio: 'ignore', windowsHide: true });
      pids.push(p.pid!);
      return p.pid!;
    },
  });
  t.after(async () => {
    t.mock.restoreAll();
    h.s.detach();
    await cleanUp(root, ...pids);
  });
  const beat = () => fs.appendFileSync(f.out, JSON.stringify({ op: 'beat' }) + '\n');
  h.s.send('the first start', 'orchestrator');
  beat();
  beat();
  await until('the first start\'s offset saved', () => saved(f.offset) === fs.statSync(f.out).size && saved(f.offset) > 0);

  // The next poll write is held before its open: still queued when the host starts again (the case on Linux, w6499).
  const open = fs.promises.open;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let slow = 0;
  let landed = 0;
  t.mock.method(fs.promises, 'open', async (...a: Parameters<typeof open>) => {
    if (String(a[0]) !== f.offset) return open(...a);
    if (slow++ === 0) {
      await held;
      landed++;
    }
    return open(...a);
  });
  beat();
  const old = fs.statSync(f.out).size;
  await until('the first start\'s next write is held', () => slow === 1);

  // A new start: its folder made again, its offset '0'. Then the held write of the first start goes on.
  (h.s as unknown as { start(c: { op: 'send'; text: string; from: string }): boolean }).start({ op: 'send', text: 'the second start', from: 'orchestrator' });
  assert.equal(saved(f.offset), 0, 'the new start saves 0');
  beat();
  const end = fs.statSync(f.out).size;
  await until('the last line of the new start read', () => (h.s as unknown as { tail?: { position: number } }).tail?.position === end);
  assert.ok(end < old, 'the new start has read less than the old one had');

  // The daemon goes while the first start's write is still held, then that write goes on: it must not land.
  const offsetWrite = () => (h.s as unknown as { offsetWrite?: Promise<void> }).offsetWrite;
  h.s.detach();
  release();
  await until('the held write went on', () => landed === 1 && !offsetWrite());
  await new Promise((r) => setTimeout(r, 300));
  const next = Math.max(saved(f.offset) || 0, saved(f.offsetStop) || 0);
  assert.equal(next, end, `the next daemon reads from what the new start read (${end}), not from the first start's offset (${old})`);
});

test('w6554: daemon.progress is written off the event loop, and a failed write lets the next progress try again', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w6554-progress-'));
  const dir = path.join(root, 'p1');
  const { pid, child } = await fakeHost(dir);
  const answered: string[] = [];
  const handlers = () => ({ read_work: async (args: unknown) => (answered.push(String((args as { n: string }).n)), 'ok') });
  const f = hostFiles(dir);
  const call = (n: string) => fs.appendFileSync(f.out, JSON.stringify({ op: 'rpc', id: n, method: 'read_work', args: { n } }) + '\n');
  const h = hostedOn(root, 'p1', { handlers });
  t.after(async () => {
    h.s.detach();
    await cleanUp(root, pid, child);
  });
  const sync = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (...a: Parameters<typeof sync>) => {
    if (String(a[0]) === f.progress) throw new Error('daemon.progress written synchronously');
    return sync(...a);
  });
  const write = fs.promises.writeFile;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let tries = 0;
  let fail = true;
  t.mock.method(fs.promises, 'writeFile', async (...a: Parameters<typeof write>) => {
    if (String(a[0]) === f.progress) {
      tries++;
      if (fail) {
        fail = false;
        throw new Error('a slow disk gave up');
      }
      await held;
    }
    return write(...a);
  });
  assert.equal(h.s.adopt(), true);
  call('r1');
  await until('r1 answered and its progress write failed', () => answered.includes('r1') && tries === 1);
  assert.equal(fs.existsSync(f.progress), false);
  call('r2');
  await until('r2 answered while the retried write is held', () => answered.includes('r2') && tries === 2);
  call('r3');
  await until('r3 answered, the loop free while the write is held', () => answered.includes('r3'));
  assert.equal(tries, 2, 'no second write races the held one, and the minute between saves holds');
  release();
  await until('the progress saved', () => savedProgress(dir) > 0);
});
