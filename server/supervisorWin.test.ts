import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import * as win from './machineDeployWin.ts';
import { SUPERVISOR_HAS_DAEMON, winControlAnswer } from './machineDeploy.ts';
import { DAEMON_ENDING_MARKER } from '../machine/freezeWatch.ts';
import { DAEMON_ALIVE, SELF_REBOOT_STATE } from '../machine/selfReboot.ts';
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
// w6792: \`linked\` says it works as a real daemon does (machine/selfReboot.ts writeAlive); stop.txt ends any run with 75.
// \`linkedstuck\` said it works once, then 1 s later writes its ending marker and never exits: its heartbeat is still fresh.
if (what === 'linkedstuck') {
  fs.writeFileSync(path.join(dir, 'logs', '${DAEMON_ALIVE}'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), linked: true }));
  setTimeout(() => fs.writeFileSync(path.join(dir, 'logs', '${DAEMON_ENDING_MARKER}'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), why: 'test: stuck' })), 1000);
}
if (what === 'linked') setInterval(() => fs.writeFileSync(path.join(dir, 'logs', '${DAEMON_ALIVE}'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), linked: true })), 100);
setInterval(() => {
  if (fs.existsSync(path.join(dir, 'stop.txt'))) process.exit(75);
}, 100);
`;

interface Rig {
  dir: string;
  log: () => string;
  pids: () => { pid: number; what: string }[];
  run: (opts?: { noKill?: boolean }) => Promise<{ code: number | null; took: number }>;
  end: () => void;
}

// A state file the supervisor swaps in, read as its readers do: a read in the swap finds none or finds it busy, so up to 20
// tries 50 ms apart (w6792; machineDeployWin.ts Put-File).
function readState(file: string) {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (e) {
      if (i >= 19) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

// w6792: the self-reboot's readers made files the test writes: elig.ps1 answers the eligibility check (not eligible unless a
// test writes another), idle.txt the console's idle seconds, console.txt why the console is not this session's (empty: it is).
const NOT_ELIGIBLE_PS = "param($taskName) [pscustomobject]@{ eligible = $false; why = 'test: not eligible'; task = $null }";
const ELIGIBLE_PS = "param($taskName) [pscustomobject]@{ eligible = $true; why = 'test: eligible'; task = $true }";

function rig(t: { after: (fn: () => void) => void }, plan: string, opts: { delay?: number; rebootAfterS?: number } = {}): Rig {
  // The fake daemons end before the folder goes (after hooks run in the order they were added): Windows keeps a live
  // process's files, and the removal failed with EPERM on CI.
  let dir = '';
  t.after(() => end());
  dir = tmpDir('ffsup-', t as never);
  fs.mkdirSync(path.join(dir, 'app', 'machine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'machine', 'daemon.ts'), FAKE_DAEMON);
  fs.writeFileSync(path.join(dir, 'daemon.json'), '{}');
  fs.writeFileSync(path.join(dir, 'plan.txt'), plan);
  fs.writeFileSync(path.join(dir, 'elig.ps1'), NOT_ELIGIBLE_PS);
  fs.writeFileSync(path.join(dir, 'idle.txt'), '99999');
  let s = win.supervisorScript(process.execPath, false);
  const swap = (from: string, to: string) => {
    assert.ok(s.includes(from), `the supervisor has ${from}`);
    s = s.replace(from, to);
  };
  swap(`$rebootAfterS = ${win.SUPERVISOR_REBOOT_AFTER_S}
`, `$rebootAfterS = ${opts.rebootAfterS ?? win.SUPERVISOR_REBOOT_AFTER_S}
`);
  swap('.AddScript($eligCheck)', ".AddScript((Get-Content -LiteralPath (Join-Path $F 'elig.ps1') -Raw))");
  s = s.replace(/^function Idle-S \{.*$/m, "function Idle-S { [double](Get-Content -LiteralPath (Join-Path $F 'idle.txt') -Raw) }");
  s = s.replace(/^function Console-Why \{.*$/m, "function Console-Why { $c = Get-Content -LiteralPath (Join-Path $F 'console.txt') -Raw -ErrorAction SilentlyContinue; if ($c) { $c.Trim() } }");
  assert.ok(s.includes("Join-Path $F 'idle.txt'") && s.includes("Join-Path $F 'console.txt'"), 'the console readers are stubbed');
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
  const state = readState(path.join(r.dir, 'logs', win.SUPERVISOR_STATE));
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

// w6792: the self-reboot, warn only (lothsahn's lockout rule: stage 1 logs "would reboot now, reason X" and tells the portal).
// Each test runs the whole supervisor with a 3 s stuck window for the 900 s one: a daemon stuck mid-exit is left behind (w6784)
// and a fresh `live` one never says it works, so the episode goes on; stop.txt then ends the run.
const REBOOT_AFTER_S = 3;
const rebootState = (dir: string) => readState(path.join(dir, 'logs', SELF_REBOOT_STATE));
const stopRun = async (r: Rig, done: Promise<{ code: number | null }>) => {
  fs.writeFileSync(path.join(r.dir, 'stop.txt'), '');
  const { code } = await done;
  assert.equal(code, 0, r.log());
};

test('windows (real PowerShell): a stuck episode with no working daemon 15 minutes on says "would reboot now", once, and reboots nothing (w6792)', { skip }, async (t) => {
  const r = rig(t, 'stuck,live', { rebootAfterS: REBOOT_AFTER_S });
  fs.writeFileSync(path.join(r.dir, 'elig.ps1'), ELIGIBLE_PS);
  const done = r.run({ noKill: true });
  await until('would reboot', () => r.log().includes('would reboot now'));
  await new Promise((res) => setTimeout(res, 1500));
  await stopRun(r, done);
  const log = r.log();
  const [stuck] = r.pids();
  assert.match(log, /self-reboot: eligible: test: eligible; mode warn only \(w6792\)/);
  assert.match(log, new RegExp(`self-reboot: a stuck episode began at \\S+ \\(pid ${stuck.pid} said it ends \\(test: stuck\\) and did not exit\\)`));
  assert.match(log, new RegExp(`self-reboot: would reboot now \\(warn only\\), reason: the daemon was stuck \\d+ min \\(pid ${stuck.pid} said it ends \\(test: stuck\\) and did not exit\\) and this supervisor's own recovery brought back no working daemon \\(w6792\\)`));
  assert.equal(log.match(/would reboot now/g)?.length, 1, 'once per episode');
  assert.ok(log.indexOf('stuck episode began') < log.indexOf('would reboot now'));
  // The timing: not before the window, counted from when the daemon said it ends (its marker), and not long after.
  const st = rebootState(r.dir);
  assert.equal(st.mode, 'warn');
  assert.equal(st.eligible, true);
  assert.equal(st.last.mode, 'warn');
  const waited = (Date.parse(st.last.at) - Date.parse(st.last.stuckSince)) / 1000;
  assert.ok(waited >= REBOOT_AFTER_S && waited < REBOOT_AFTER_S + 10, `answered ${waited} s after the stuck state began`);
  assert.equal(st.stuckSince, st.last.stuckSince, 'the episode is still going on');
});

test('windows (real PowerShell): a fresh daemon that says it works ends the stuck episode: no reboot (w6792)', { skip }, async (t) => {
  const r = rig(t, 'stuck,linked', { rebootAfterS: REBOOT_AFTER_S });
  fs.writeFileSync(path.join(r.dir, 'elig.ps1'), ELIGIBLE_PS);
  const done = r.run({ noKill: true });
  await until('the episode over', () => r.log().includes('the episode is over'));
  await new Promise((res) => setTimeout(res, (REBOOT_AFTER_S + 1.5) * 1000));
  await stopRun(r, done);
  const [, fresh] = r.pids();
  assert.match(r.log(), new RegExp(`self-reboot: the daemon, pid ${fresh.pid}, works \\(linked to the portal\\) \\d+ min after the stuck state began: the episode is over, no reboot \\(w6792\\)`));
  assert.doesNotMatch(r.log(), /would reboot now/);
  const st = rebootState(r.dir);
  assert.equal(st.stuckSince, undefined);
  assert.equal(st.last, undefined);
});

test('windows (real PowerShell): a heartbeat the stuck daemon wrote before it said it ends does not end the episode (w6809 review)', { skip }, async (t) => {
  // supervisor-warn-only keeps the stuck daemon (w6784), so the supervisor's daemon is still the one whose heartbeat is fresh.
  const r = rig(t, 'linkedstuck,yield', { rebootAfterS: REBOOT_AFTER_S });
  fs.writeFileSync(path.join(r.dir, 'elig.ps1'), ELIGIBLE_PS);
  fs.writeFileSync(path.join(r.dir, win.SUPERVISOR_WARN_ONLY), '');
  const done = r.run({ noKill: true });
  await until('would reboot', () => r.log().includes('would reboot now'));
  await stopRun(r, done);
  assert.match(r.log(), /self-reboot: a stuck episode began/);
  assert.doesNotMatch(r.log(), /the episode is over/);
});

test('windows (real PowerShell): a machine that would not come back by itself only logs why (w6792)', { skip }, async (t) => {
  const r = rig(t, 'stuck,live', { rebootAfterS: REBOOT_AFTER_S });
  const done = r.run({ noKill: true });
  await until('not eligible', () => r.log().includes('no reboot: this machine would not come back by itself: test: not eligible'));
  await stopRun(r, done);
  assert.match(r.log(), /self-reboot: not eligible: test: not eligible; mode warn only \(w6792\)/);
  assert.doesNotMatch(r.log(), /would reboot now/);
  const st = rebootState(r.dir);
  assert.equal(st.eligible, false);
  assert.equal(st.skip.why, 'this machine would not come back by itself: test: not eligible');
});

test('windows (real PowerShell): another session at the console, or keyboard or mouse input in the last 30 minutes, holds it until it ends (w6792)', { skip }, async (t) => {
  const r = rig(t, 'stuck,live', { rebootAfterS: REBOOT_AFTER_S });
  fs.writeFileSync(path.join(r.dir, 'elig.ps1'), ELIGIBLE_PS);
  fs.writeFileSync(path.join(r.dir, 'idle.txt'), '120');
  fs.writeFileSync(path.join(r.dir, 'console.txt'), 'test: the console is session 2');
  const done = r.run({ noKill: true });
  await until('console held', () => r.log().includes('no reboot: test: the console is session 2'));
  fs.rmSync(path.join(r.dir, 'console.txt'));
  await until('input held', () => r.log().includes('no reboot: the console had keyboard or mouse input 2 min ago; it waits for 30 min with none'));
  assert.match(rebootState(r.dir).skip.why, /keyboard or mouse input 2 min ago/);
  assert.doesNotMatch(r.log(), /would reboot now/);
  fs.writeFileSync(path.join(r.dir, 'idle.txt'), String(win.SUPERVISOR_REBOOT_IDLE_S + 1));
  await until('would reboot', () => r.log().includes('would reboot now'));
  await stopRun(r, done);
  assert.equal(r.log().match(/keyboard or mouse input/g)?.length, 1, 'a held reboot is logged once per reason');
  assert.equal(rebootState(r.dir).skip, undefined);
});

test('windows (real PowerShell): at most one automatic reboot in 6 hours, and supervisor-no-reboot turns it off (w6792)', { skip }, async (t) => {
  const r = rig(t, 'stuck,live,stuck,live', { rebootAfterS: REBOOT_AFTER_S });
  fs.writeFileSync(path.join(r.dir, 'elig.ps1'), ELIGIBLE_PS);
  fs.mkdirSync(path.join(r.dir, 'logs'), { recursive: true });
  const seed = (agoH: number) => {
    const at = new Date(Date.now() - agoH * 3600_000).toISOString();
    const last = { at, mode: 'live', why: 'test: an earlier one', stuckSince: new Date(Date.parse(at) - 900_000).toISOString() };
    fs.writeFileSync(path.join(r.dir, 'logs', SELF_REBOOT_STATE), JSON.stringify({ mode: 'warn', why: 'x', last, lastLiveAt: at }));
    return at;
  };
  const lastLiveAt = seed(1);
  fs.writeFileSync(path.join(r.dir, win.SUPERVISOR_NO_REBOOT), '');
  const done = r.run({ noKill: true });
  await until('off', () => r.log().includes(`no reboot: ${path.join(r.dir, win.SUPERVISOR_NO_REBOOT)} turns it off`));
  fs.rmSync(path.join(r.dir, win.SUPERVISOR_NO_REBOOT));
  await until('rate', () => /no reboot: it rebooted itself at \S+, under 6 h ago/.test(r.log()));
  assert.doesNotMatch(r.log(), /would reboot now/);
  // The last reboot outlives the supervisor: it is the next daemon's to report.
  const st = rebootState(r.dir);
  assert.equal(Date.parse(st.lastLiveAt), Date.parse(lastLiveAt));
  assert.equal(st.last.why, 'test: an earlier one');
  await stopRun(r, done);
  // A supervisor that starts with the last one seven hours back answers.
  fs.rmSync(path.join(r.dir, 'stop.txt'));
  seed(7);
  const again = r.run({ noKill: true });
  await until('would reboot', () => r.log().includes('would reboot now'));
  await stopRun(r, again);
});

test('windows: the warn-only stage has no way to reboot, and its switch is off (w6792)', () => {
  assert.equal(win.SUPERVISOR_REBOOT_LIVE, false);
  const s = win.supervisorScript('C:\\node\\node.exe', false);
  assert.match(s, /^\$rebootLive = \$false$/m);
  assert.doesNotMatch(s, /shutdown|Restart-Computer|NtShutdownSystem|InitiateSystemShutdown|ExitWindowsEx/i);
  // The eligibility check reads the Winlogon key's values by name, never the stored password's.
  const e = win.selfRebootEligibilityScript();
  assert.doesNotMatch(e, /GetValue\('DefaultPassword'\)|Get-ItemProperty/);
  assert.match(e, /\$w\.names -contains 'DefaultPassword'/);
});

// w6792: the eligibility check, its readers replaced after ELIG_READERS_END with fakes (a later function replaces an earlier one).
// The base answers as BEAST did on 2026-11-28: automatic logon on for this user, no DefaultPassword value (the password in the
// LSA), the last boot logged on by itself 11 s after it started and 2.3 s after the console connected, and the logon task there.
const ELIG_BASE = `function Read-Winlogon { @{ names = @('AutoAdminLogon', 'DefaultUserName', 'AutoLogonSID'); auto = '1'; user = 'rydin'; domain = 'BEAST'; autoSid = 'S-1-5-21-1' } }
function Read-Who { @{ name = 'BEAST\\rydin'; sid = 'S-1-5-21-1'; groups = @('S-1-1-0', 'S-1-11-96-9'); user = 'rydin'; domain = 'BEAST'; computer = 'BEAST' } }
function Read-Sid($domain, $user) { if ($user -eq 'me@example.com') { 'S-1-11-96-9' } else { 'S-1-5-21-2' } }
function Read-Logon { @(11, 2.3) }
function Read-Task { $true }
`;
const winlogon = (fields: string) => `function Read-Winlogon { $w = @{ names = @('AutoAdminLogon', 'DefaultUserName'); auto = '1'; user = 'rydin'; domain = 'BEAST'; autoSid = '' }; ${fields}; $w }`;

test('windows (real PowerShell): a machine is eligible only when it would come back by itself, read without the password (w6792)', { skip }, async (t) => {
  const cases: { name: string; fakes?: string; prev?: boolean; eligible: boolean; why: RegExp; task?: boolean | null }[] = [
    { name: 'BEAST', eligible: true, task: true, why: /^automatic logon to this daemon's user \(BEAST\\rydin\), its password stored \(the last boot logged this user on by itself 11 s after it started, 2\.3 s after the console connected, and AutoAdminLogon stayed 1\), and the FFFactoryDaemon logon task$/ },
    { name: 'off', fakes: winlogon("$w.auto = '0'"), eligible: false, why: /^automatic logon is off \(Winlogon AutoAdminLogon is '0', not 1\)$/ },
    { name: 'unset', fakes: winlogon("$w.auto = ''"), eligible: false, why: /AutoAdminLogon is '', not 1/ },
    { name: 'another SID', fakes: winlogon("$w.autoSid = 'S-1-5-21-7'"), eligible: false, why: /^automatic logon is for another account \(Winlogon AutoLogonSID is not this daemon's user, BEAST\\rydin\)$/ },
    { name: 'another name', fakes: winlogon("$w.user = 'guest'"), eligible: false, why: /^automatic logon names another account than this daemon's user \(BEAST\\rydin\)$/ },
    { name: 'another domain', fakes: winlogon("$w.domain = 'CORP'"), eligible: false, why: /names another account/ },
    // A Microsoft account: its address, matched by the group SID this user's token carries; a DefaultPassword value by its name.
    { name: 'Microsoft account', fakes: `${winlogon("$w.user = 'me@example.com'; $w.domain = 'MicrosoftAccount'; $w.names += 'DefaultPassword'")}\nfunction Read-Logon { throw 'never asked' }`, eligible: true, task: true, why: /^automatic logon to this daemon's user \(BEAST\\rydin\), its password stored \(a DefaultPassword value, not read\), and the FFFactoryDaemon logon task$/ },
    { name: 'a slow logon', fakes: 'function Read-Logon { @(300, 40) }', eligible: false, why: /^no stored password for automatic logon can be seen: no DefaultPassword value, and this user's logon came 300 s after the last boot and 40 s after the console connected \(by itself: within 120 s and 5 s\); one in the LSA only an administrator can check$/ },
    { name: 'a quick logon typed late', fakes: 'function Read-Logon { @(60, 30) }', eligible: false, why: /no stored password/ },
    { name: 'no logon times', fakes: 'function Read-Logon { $null }', eligible: false, why: /this session's logon times could not be read/ },
    { name: 'no task', fakes: "function Read-Task { 'ERROR: The system cannot find the file specified.' }", eligible: false, task: false, why: /^schtasks finds no FFFactoryDaemon logon task \(ERROR: The system cannot find the file specified\.\), so the daemon would not start after a reboot$/ },
    // The Task Scheduler hung (BEAST, w6784): the last answer stands; with none yet it says so.
    { name: 'hung, seen before', fakes: 'function Read-Task { $null }', prev: true, eligible: true, task: true, why: /and the FFFactoryDaemon logon task$/ },
    { name: 'hung, never seen', fakes: 'function Read-Task { $null }', eligible: false, task: null, why: /^the Task Scheduler did not say in 15 s whether the FFFactoryDaemon logon task is there$/ },
  ];
  const dir = tmpDir('ffelig-', t as never);
  const script = win.selfRebootEligibilityScript();
  assert.ok(script.includes(win.ELIG_READERS_END));
  cases.forEach((c, i) => fs.writeFileSync(path.join(dir, `case${i}.ps1`), script.replace(win.ELIG_READERS_END, `${ELIG_BASE}${c.fakes ?? ''}\n`)));
  fs.writeFileSync(
    path.join(dir, 'drive.ps1'),
    `$prev = @(${cases.map((c) => (c.prev ? '$true' : '$null')).join(', ')})
for ($i = 0; $i -lt ${cases.length}; $i++) {
  $r = & (Join-Path $PSScriptRoot "case$i.ps1") 'FFFactoryDaemon' '' $prev[$i] ${win.SUPERVISOR_AUTOLOGON_BOOT_S} ${win.SUPERVISOR_AUTOLOGON_CONNECT_S}
  [pscustomobject]@{ eligible = $r.eligible; why = $r.why; task = $r.task } | ConvertTo-Json -Compress
}
`,
  );
  const out = await new Promise<string>((res, rej) =>
    execFile(powershell!, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'drive.ps1')], { timeout: 60_000 }, (e, so, se) => (e ? rej(new Error(`${e.message}\n${se}`)) : res(so))),
  );
  const answers = out.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.equal(answers.length, cases.length, out);
  cases.forEach((c, i) => {
    assert.equal(answers[i].eligible, c.eligible, `${c.name}: ${answers[i].why}`);
    assert.match(answers[i].why, c.why, c.name);
    if (c.task !== undefined) assert.equal(answers[i].task, c.task, c.name);
  });
});
