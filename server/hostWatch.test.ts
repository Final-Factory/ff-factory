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
import { HostedSession, hostFiles, hostFolders, hostLook, pidAlive, HOST_PROTOCOL, type HostDeps } from '../machine/agentHost.ts';
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
