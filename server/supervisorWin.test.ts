import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import * as win from './machineDeployWin.ts';
import { SUPERVISOR_HAS_DAEMON, winControlAnswer } from './machineDeploy.ts';
import { DAEMON_ENDING_MARKER } from '../machine/freezeWatch.ts';
import { powershell } from './testPowershell.ts';
import { tmpDir } from './testTmp.ts';

// w6784, stage 2: the whole supervisor (run-daemon.ps1) run by real PowerShell (Windows PowerShell 5.1 on Windows, pwsh on
// macOS and Linux) against a fake daemon whose every run does what plan.txt says: `stuck` writes its ending marker and never
// exits, `live` runs until it is ended, `yield` exits 75 at once (DAEMON_YIELD_EXIT), which ends the supervisor and the test.
// A process stuck mid-exit cannot be made on purpose, so a stuck run's kill is a no-op (the supervisor's Stop-Held, which
// ends the daemon through its held handle, made empty); on Windows that run then really holds daemon.log, as BEAST's pid
// 16100 did.

const FAKE_DAEMON = `const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
const dir = path.dirname(process.argv[process.argv.length - 1]);
const count = path.join(dir, 'runs.txt');
const n = (fs.existsSync(count) ? +fs.readFileSync(count, 'utf8') : 0) + 1;
fs.writeFileSync(count, String(n));
const what = fs.readFileSync(path.join(dir, 'plan.txt'), 'utf8').trim().split(',')[n - 1] || 'yield';
fs.appendFileSync(path.join(dir, 'pids.txt'), process.pid + ' ' + what + '\\n');
console.log('run ' + n + ': ' + what);
if (what === 'yield') process.exit(75);
if (what === 'stuck') fs.writeFileSync(path.join(dir, 'logs', '${DAEMON_ENDING_MARKER}'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), why: 'test: stuck' }));
setInterval(() => {}, 1000);
`;

interface Rig {
  dir: string;
  log: () => string;
  pids: () => { pid: number; what: string }[];
  run: (opts?: { noKill?: boolean }) => Promise<{ code: number | null; took: number }>;
  end: () => void;
}

function rig(t: { after: (fn: () => void) => void }, plan: string, opts: { delay?: number } = {}): Rig {
  // The fake daemons end before the folder goes (after hooks run in the order they were added): Windows keeps a live
  // process's files, and the removal failed with EPERM on CI.
  let dir = '';
  t.after(() => end());
  dir = tmpDir('ffsup-', t as never);
  fs.mkdirSync(path.join(dir, 'app', 'machine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'machine', 'daemon.ts'), FAKE_DAEMON);
  fs.writeFileSync(path.join(dir, 'daemon.json'), '{}');
  fs.writeFileSync(path.join(dir, 'plan.txt'), plan);
  let s = win.supervisorScript(process.execPath, false);
  // Test speed: 1 s to call a marked daemon stuck, 200 ms steps, 1 s for a kill to take, no back-off.
  s = s.replace(`$stuckAfter = ${win.SUPERVISOR_STUCK_AFTER_S}\n`, '$stuckAfter = 1\n').replace('$waitStepMs = 5000\n', '$waitStepMs = 200\n').replace('$p.WaitForExit(15000)', '$p.WaitForExit(1000)').replace(/\$delay = 10\b/g, `$delay = ${opts.delay ?? 0}`).replace('$leftWaitS = 10\n', '$leftWaitS = 0\n');
  if (process.platform !== 'win32') s = s.replace(/-WindowStyle Hidden /g, '').replace("'machine\\daemon.ts'", "'machine/daemon.ts'");
  const pids = () =>
    fs.existsSync(path.join(dir, 'pids.txt'))
      ? fs
          .readFileSync(path.join(dir, 'pids.txt'), 'utf8')
          .trim()
          .split(/\r?\n/)
          .map((l) => ({ pid: +l.split(' ')[0], what: l.split(' ')[1] }))
      : [];
  function end() {
    if (!dir) return;
    for (const p of pids()) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
  }
  return {
    dir,
    pids,
    end,
    log: () => (fs.existsSync(path.join(dir, 'logs', 'supervisor.log')) ? fs.readFileSync(path.join(dir, 'logs', 'supervisor.log'), 'utf8') : ''),
    run: ({ noKill } = {}) => {
      const script = path.join(dir, 'run-daemon.ps1');
      const held = 'function Stop-Held($p) { $p.Kill() }';
      assert.ok(s.includes(held), 'the supervisor ends its daemon through Stop-Held');
      fs.writeFileSync(script, noKill ? s.replace(held, 'function Stop-Held($p) { }') : s);
      const t0 = Date.now();
      return new Promise((resolve) => {
        // 'exit', not execFile's close: a daemon left behind inherits the supervisor's output handles on Windows and keeps
        // them open, so a wait for the pipes to close lasted until the timeout (66 s on CI).
        const c = spawn(powershell!, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'ignore' });
        const timer = setTimeout(() => c.kill(), 60_000);
        c.on('exit', (code) => {
          clearTimeout(timer);
          resolve({ code, took: Date.now() - t0 });
        });
      });
    },
  };
}

const until = async (what: string, ok: () => boolean, ms = 30_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 100))) if (ok()) return;
  throw new Error(`timed out waiting for ${what}`);
};

const skip = !powershell && 'no PowerShell here';

test('windows (real PowerShell): a daemon stuck mid-exit is ended again, then left behind and a fresh one started beside it (w6784)', { skip }, async (t) => {
  const r = rig(t, 'stuck,yield');
  const { code } = await r.run({ noKill: true });
  assert.equal(code, 0, r.log());
  const [stuck, fresh] = r.pids();
  assert.equal(stuck.what, 'stuck');
  assert.equal(fresh?.what, 'yield', r.log());
  const log = r.log();
  assert.match(log, new RegExp(`the daemon, pid ${stuck.pid}, said it ends \\(test: stuck\\) \\d+ s ago and has still not exited: ending it again \\(w6784\\)`));
  assert.match(log, new RegExp(`the daemon, pid ${stuck.pid}, is still there: it is stuck mid-exit; left behind, a fresh one starts beside it \\(w6784\\)`));
  assert.match(log, new RegExp(`started the daemon, pid ${fresh.pid}`));
  assert.ok(log.indexOf('left behind') < log.indexOf(`started the daemon, pid ${fresh.pid}`));
  // The stuck one really still runs: left behind, never waited on.
  assert.doesNotThrow(() => process.kill(stuck.pid, 0));
  const state = JSON.parse(fs.readFileSync(path.join(r.dir, 'logs', win.SUPERVISOR_STATE), 'utf8').replace(/^﻿/, ''));
  assert.deepEqual([state.abandoned].flat(), [stuck.pid]);
  if (process.platform === 'win32') assert.match(log, /daemon\.log is still held \(abandoned daemon pid\(s\) \d+\); this daemon writes daemon\.held1\.log/);
});

test('windows (real PowerShell): with supervisor-warn-only a daemon stuck mid-exit is only logged, and waited for (w6784)', { skip }, async (t) => {
  const r = rig(t, 'stuck,yield');
  fs.writeFileSync(path.join(r.dir, win.SUPERVISOR_WARN_ONLY), '');
  const done = r.run({ noKill: true });
  await until('the stuck line', () => /it is stuck mid-exit; .* says warn only/.test(r.log()));
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(r.pids().length, 1, 'no fresh daemon beside it');
  process.kill(r.pids()[0].pid, 'SIGKILL');
  assert.equal((await done).code, 0);
  assert.match(r.log(), /has exited after all/);
  assert.equal(r.pids()[1].what, 'yield');
});

test('windows (real PowerShell): a restart over ssh asks the live supervisor, with no Task Scheduler; a start leaves its daemon be (w6784)', { skip }, async (t) => {
  const r = rig(t, 'live,yield');
  const done = r.run();
  const state = path.join(r.dir, 'logs', win.SUPERVISOR_STATE);
  await until('the supervisor state', () => fs.existsSync(state) && /"daemonPid":\d+/.test(fs.readFileSync(state, 'utf8')));
  const ps = (action: 'start' | 'restart') =>
    new Promise<string>((resolve, reject) => {
      const s = win.controlScript(action, r.dir);
      const f = path.join(r.dir, `${action}.ps1`);
      fs.writeFileSync(f, s);
      execFile(powershell!, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { timeout: 90_000, env: { ...process.env, USERPROFILE: process.env.USERPROFILE ?? r.dir } }, (e, out, err) => (e ? reject(new Error(`${e.message}\n${out}\n${err}`)) : resolve(out)));
    });
  await until("the daemon's first run", () => r.pids().length === 1);
  const live = r.pids()[0].pid;
  const started = await ps('start');
  assert.match(started, new RegExp(`supervisor=\\d+ daemonPid=${live}`));
  assert.doesNotMatch(started, /started=/, 'the task route is skipped');
  assert.match(winControlAnswer(started), new RegExp(`its supervisor \\(pid \\d+\\) ${SUPERVISOR_HAS_DAEMON.replace(/[()]/g, '\\$&')} pid ${live}`));
  assert.equal(r.pids().length, 1, 'a start ended nothing');
  const restarted = await ps('restart');
  assert.match(restarted, /restartedBy=supervisor daemonPid=\d+/, restarted);
  assert.doesNotMatch(restarted, /stopped=|started=/, 'neither Stop-FFDaemon nor the task ran');
  const fresh = r.pids()[1];
  assert.equal(fresh.what, 'yield');
  assert.match(winControlAnswer(restarted), new RegExp(`its supervisor \\(pid \\d+\\) started a fresh daemon, pid ${fresh.pid}, in place of pid ${live}, without the Task Scheduler`));
  assert.equal((await done).code, 0);
  assert.match(r.log(), /a restart was asked \(machine_daemon restart over ssh\): ending the daemon/);
  assert.throws(() => process.kill(live, 0), 'the old daemon was ended');
  assert.ok(!fs.existsSync(path.join(r.dir, 'logs', win.SUPERVISOR_REQUEST)), 'the request was taken');
});

test('windows (real PowerShell): a held daemon.log gets daemon.held1.log, and the next rotation keeps both as archives (w6784)', { skip }, async (t) => {
  const dir = tmpDir('ffsup-rot-', t as never);
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'daemon.log'), 'old run\n');
  const s = win.supervisorScript(process.execPath, false);
  const fn = /function Rotate-Out\(\$base\) \{[\s\S]*?\n\}\n/.exec(s)?.[0];
  assert.ok(fn, 'Rotate-Out in supervisorScript');
  const script = [
    '$logs = $env:FFLOGS',
    fn,
    // daemon.log is held: its move fails, as a stuck process's open handle makes it on Windows.
    'function Move-Item { param($LiteralPath, $Destination, $ErrorAction) if ((Split-Path -Leaf $LiteralPath) -eq "daemon.log") { throw "held" } else { Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination } }',
    '"first=" + (Rotate-Out "daemon")',
    'Set-Content -LiteralPath (Join-Path $logs "daemon.held1.log") -Value "fresh run"',
    'Remove-Item Function:\\Move-Item',
    '"second=" + (Rotate-Out "daemon")',
  ].join('\n');
  const out = await new Promise<string>((resolve, reject) =>
    execFile(powershell!, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FFLOGS: logs } }, (e, o, err) => (e ? reject(new Error(`${e.message}\n${o}\n${err}`)) : resolve(o))),
  );
  assert.match(out, /first=daemon\.held1\.log/);
  assert.match(out, /second=daemon\.log/);
  const archives = fs.readdirSync(logs).filter((f) => /^daemon\.log\.\d{8}T\d{9}Z(-\d+)?$/.test(f));
  assert.equal(archives.length, 2, fs.readdirSync(logs).join(', '));
  assert.deepEqual(archives.map((f) => fs.readFileSync(path.join(logs, f), 'utf8').trim()).sort(), ['fresh run', 'old run']);
});

test('windows (real PowerShell): a restart request older than the asker waits is dropped, a fresh one taken once (w6790)', { skip }, async (t) => {
  const dir = tmpDir('ffsup-req-', t as never);
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  const req = path.join(logs, win.SUPERVISOR_REQUEST);
  const s = win.supervisorScript(process.execPath, false);
  const fn = /function Take-Request \{[\s\S]*?\n\}\n/.exec(s)?.[0];
  assert.ok(fn, 'Take-Request in supervisorScript');
  const script = [
    '$logs = $env:FFLOGS',
    `$request = Join-Path $logs '${win.SUPERVISOR_REQUEST}'`,
    '$log = Join-Path $logs "supervisor.log"',
    'function Say($line) { $line | Out-File $log -Append -Encoding utf8 }',
    fn,
    '"old=" + [string](Take-Request)',
    `Set-Content -LiteralPath $request -Value '{"why":"fresh ask"}'`,
    '"fresh=" + [string](Take-Request)',
    '"again=" + [string](Take-Request)',
  ].join('\n');
  fs.writeFileSync(req, JSON.stringify({ why: 'left behind' }));
  const old = new Date(Date.now() - (win.SUPERVISOR_ANSWER_S + 30) * 1000);
  fs.utimesSync(req, old, old);
  const out = await new Promise<string>((resolve, reject) =>
    execFile(powershell!, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FFLOGS: logs } }, (e, o, err) => (e ? reject(new Error(`${e.message}\n${o}\n${err}`)) : resolve(o))),
  );
  assert.match(out, /^old=\s*$/m, out);
  assert.match(out, /^fresh=fresh ask\s*$/m, out);
  assert.match(out, /^again=\s*$/m, out);
  assert.ok(!fs.existsSync(req));
  assert.match(fs.readFileSync(path.join(logs, 'supervisor.log'), 'utf8'), /dropped a restart request \d+ s old/);
});

test('windows (real PowerShell): an asked restart starts at once but keeps the back-off for the next exit (w6784 Worker update CI)', { skip }, async (t) => {
  const r = rig(t, 'live,live,yield', { delay: 1 });
  const done = r.run();
  await until("the daemon's first run", () => r.pids().length === 1);
  fs.writeFileSync(path.join(r.dir, 'logs', win.SUPERVISOR_REQUEST), JSON.stringify({ why: 'test ask' }));
  await until('the asked restart', () => r.pids().length === 2);
  // The second daemon is ended from outside (as an update's Stop-FFDaemon does): the supervisor waits its back-off.
  process.kill(r.pids()[1].pid, 'SIGKILL');
  assert.equal((await done).code, 0, r.log());
  const log = r.log();
  assert.match(log, /a restart was asked \(test ask\)/);
  assert.match(log, /starting it again in 0 s/, 'the asked restart starts at once');
  const waits = [...log.matchAll(/starting it again in (\d+) s/g)].map((m) => +m[1]);
  assert.ok(waits.at(-1)! >= 2, `the exit after an asked restart waits its back-off, not 0: ${waits.join(', ')}\n${log}`);
});
