import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  FirefoxCloser,
  RESUME_PREF,
  closeFirefox,
  closeMessage,
  firefoxFile,
  firefoxInstances,
  parseProfilesIni,
  profileArg,
  profileInUse,
  readFirefoxEnabled,
  resumeOnce,
  winCloseWindows,
  winCountWindows,
  winListFirefox,
  type CloseResult,
  type FirefoxDeps,
  type FirefoxProc,
} from '../machine/firefox.ts';

/**
 * The tray's Close Firefox (w1593, machine/firefox.ts; docs/machines.md "Closing Firefox to free RAM"): WM_CLOSE to the
 * session's Firefox windows, a wait, the RAM before and after, its profiles set to restore once, and never a kill: a
 * Firefox that asks something or does not end is left running and the notification says so.
 */

const GB = 2 ** 30;
const proc = (pid: number, ppid: number, extra: Partial<FirefoxProc> = {}): FirefoxProc => ({
  pid,
  ppid,
  session: 1,
  workingSet: 0.2 * GB,
  privateBytes: 0.5 * GB,
  commandLine: pid > 1000 ? `"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -contentproc -isForBrowser -prefsHandle 1234 ${ppid} tab` : '"C:\\Program Files\\Mozilla Firefox\\firefox.exe"',
  ...extra,
});

test('Firefox instances: a main process with its children at any depth; other sessions and background tasks left out', () => {
  const procs = [
    proc(100, 7),
    proc(1101, 100),
    proc(1102, 100),
    proc(1103, 1101), // a child's child
    proc(200, 7, { commandLine: 'firefox.exe -profile "D:\\ff tmp\\prof" -no-remote' }),
    proc(1201, 200),
    proc(300, 7, { session: 2 }), // another person's session
    proc(400, 7, { commandLine: 'firefox.exe --backgroundtask defaultagent' }),
  ];
  const got = firefoxInstances(procs, 1);
  assert.deepEqual(
    got.map((i) => [i.main.pid, i.children.map((c) => c.pid).sort(), i.profile]),
    [
      [100, [1101, 1102, 1103], undefined],
      [200, [1201], 'D:\\ff tmp\\prof'],
    ],
  );
  assert.equal(profileArg('firefox.exe -profile C:\\p1 -new-window'), 'C:\\p1');
  assert.equal(profileArg('firefox.exe --profile "C:\\a b"'), 'C:\\a b');
  assert.equal(profileArg('firefox.exe -P work'), undefined, '-P names a profile, not a folder: profiles.ini lists it');
});

test('profiles.ini: relative and absolute profile folders; the [Install] section adds nothing', () => {
  const ini = ['[Install308046B0AF4A39CB]', 'Default=Profiles/rw.default-release', '', '[Profile1]', 'Name=default', 'IsRelative=1', 'Path=Profiles/gc.default', 'Default=1', '', '[Profile0]', 'Name=default-release', 'IsRelative=1', 'Path=Profiles/rw.default-release', '', '[Profile2]', 'IsRelative=0', 'Path=E:\\Firefox\\work', '', '[General]', 'StartWithLastProfile=1'].join('\r\n');
  const base = path.join('C:', 'Users', 'u', 'AppData', 'Roaming', 'Mozilla', 'Firefox');
  assert.deepEqual(parseProfilesIni(ini, base), [path.join(base, 'Profiles', 'gc.default'), path.join(base, 'Profiles', 'rw.default-release'), 'E:\\Firefox\\work']);
});

/** A PC's Firefox, scripted: each main process ends `exitAfter` polls after its windows closed (never: its first window asks). */
function pc(o: { procs: FirefoxProc[]; exitAfter: Record<number, number | 'never'>; windows?: number; profiles?: string[]; held?: string[]; free?: number[] }) {
  let procs = [...o.procs];
  let polls = -1;
  let clock = 0;
  const held = new Set(o.held ?? []);
  const calls: string[] = [];
  const free = [...(o.free ?? [8 * GB, 11 * GB])];
  const closedMains = new Set<number>();
  const deps: FirefoxDeps = {
    list: async () => {
      calls.push('list');
      if (polls >= 0) {
        polls++;
        for (const m of closedMains) {
          const after = o.exitAfter[m];
          if (after !== 'never' && polls >= after) {
            procs = procs.filter((p) => p.pid !== m && p.ppid !== m && !procs.some((q) => q.pid === p.ppid && q.ppid === m));
            const prof = o.procs.find((p) => p.pid === m)!.commandLine;
            for (const h of [...held]) if (prof.includes(h) || h.endsWith(`#${m}`)) held.delete(h);
          }
        }
      }
      return { session: 1, procs };
    },
    closeWindows: async (pid, waitMs) => {
      calls.push(`close ${pid}`);
      const n = o.windows ?? 2;
      if (!n) return { windows: 0, closed: 0, stuck: false };
      if (o.exitAfter[pid] === 'never') {
        // A prompt in its first window: the wait runs out, the rest are not asked.
        clock += waitMs;
        return { windows: n, closed: 0, stuck: true };
      }
      closedMains.add(pid);
      if (polls < 0) polls = 0;
      return { windows: n, closed: n, stuck: false };
    },
    freeMem: () => (free.length > 1 ? free.shift()! : free[0]),
    profileDirs: () => o.profiles ?? [],
    inUse: (d) => held.has(d),
    resumeOnce: (d) => void calls.push(`resume ${d}`),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, calls };
}

test('closed: its windows asked to close, the RAM before and after in the notification, its open profile set to restore once', async () => {
  const { deps, calls } = pc({ procs: [proc(100, 7), proc(1101, 100), proc(1102, 100)], exitAfter: { 100: 2 }, profiles: ['P#100', 'idle'], held: ['P#100'], free: [8 * GB, 11 * GB] });
  const r = await closeFirefox(deps);
  assert.equal(r.outcome, 'closed');
  assert.equal(r.windows, 2);
  assert.deepEqual(r.left, []);
  assert.deepEqual(r.resumed, ['P#100'], 'only the profile that was open, once it is no longer held');
  assert.equal(r.firefoxBytes, 1.5 * GB, 'the private memory of its three processes');
  assert.deepEqual(calls.filter((c) => c.startsWith('close')), ['close 100'], 'WM_CLOSE goes to the main process only (its children have no windows)');
  assert.equal(r.title, 'Firefox closed');
  assert.match(r.text, /^Freed 3\.0 GB \(Free RAM 8\.0 GB → 11\.0 GB\)\. Its windows and tabs come back when you start it again\.$/);
  assert.equal(r.warn, false);
});

test('a prompt or a slow Firefox: left running after the wait, said so, nothing forced, no profile touched', async () => {
  const { deps, calls } = pc({ procs: [proc(100, 7), proc(1101, 100)], exitAfter: { 100: 'never' }, profiles: ['P#100'], held: ['P#100'], free: [8 * GB, 8.1 * GB] });
  const r = await closeFirefox(deps, { waitMs: 45_000, pollMs: 1000 });
  assert.equal(r.outcome, 'left running');
  assert.deepEqual(r.left, [100]);
  assert.deepEqual(r.resumed, []);
  assert.ok(r.waitedMs >= 45_000 && r.waitedMs < 48_000, `waited the whole 45 s, no longer: ${r.waitedMs}`);
  assert.equal(calls.filter((c) => c.startsWith('close')).length, 1, 'asked once; never again, never harder');
  assert.equal(r.title, 'Firefox is still open');
  assert.match(r.text, /did not close within 45 s\. It may be asking something .*It was left running; nothing was forced\./);
  assert.equal(r.warn, true);
});

test('two Firefox (two profiles): one closes, one asks; the closed one restores, the other is left as it is', async () => {
  const procs = [proc(100, 7, { commandLine: 'firefox.exe -profile C:\\a' }), proc(1101, 100), proc(200, 7, { commandLine: 'firefox.exe -profile C:\\b' }), proc(1201, 200)];
  const { deps, calls } = pc({ procs, exitAfter: { 100: 1, 200: 'never' }, held: ['C:\\a', 'C:\\b'] });
  const r = await closeFirefox(deps, { waitMs: 10_000 });
  assert.equal(r.outcome, 'some left');
  assert.deepEqual(calls.filter((c) => c.startsWith('close')), ['close 100', 'close 200'], 'each Firefox in turn');
  assert.deepEqual(r.left, [200]);
  assert.deepEqual(r.resumed, ['C:\\a']);
  assert.match(r.text, /^1 of 2 Firefox closed; 1 still open after 10 s\./);
});

test('only the Firefox asked for (pids): another person’s Firefox in the same session is not asked to close', async () => {
  const { deps, calls } = pc({ procs: [proc(100, 7), proc(1101, 100), proc(200, 7), proc(1201, 200)], exitAfter: { 200: 1 } });
  const r = await closeFirefox(deps, { pids: [200] });
  assert.equal(r.outcome, 'closed');
  assert.deepEqual(calls.filter((c) => c.startsWith('close')), ['close 200']);
  assert.equal(r.firefoxBytes, 1 * GB, "only its own processes' memory");
});

test('no window to close, or no Firefox: nothing waited for, nothing touched', async () => {
  const none = pc({ procs: [proc(300, 7, { session: 2 })], exitAfter: {} });
  const r1 = await closeFirefox(none.deps);
  assert.equal(r1.outcome, 'not running');
  assert.ok(!none.calls.some((c) => c.startsWith('close')), "another session's Firefox is never asked");
  const hidden = pc({ procs: [proc(100, 7)], exitAfter: { 100: 'never' }, windows: 0, profiles: ['P#100'], held: ['P#100'] });
  const r2 = await closeFirefox(hidden.deps);
  assert.equal(r2.outcome, 'no window');
  assert.equal(r2.waitedMs, 0);
  assert.deepEqual(r2.resumed, []);
  assert.match(r2.text, /left running\. Nothing was forced\./);
});

test('the notification fits a Windows balloon (255 characters) for every outcome', () => {
  const base: Omit<CloseResult, 'title' | 'text' | 'warn' | 'outcome'> = { windows: 9, instances: 12, closedInstances: 11, left: [1], freeBefore: 123.4 * GB, freeAfter: 99.9 * GB, firefoxBytes: 64.2 * GB, resumed: [], waitedMs: 45_000 };
  for (const outcome of ['not running', 'closed', 'some left', 'left running', 'no window'] as const) {
    const m = closeMessage({ ...base, outcome });
    assert.ok(m.text.length <= 255, `${outcome}: ${m.text.length} characters: ${m.text}`);
  }
  assert.match(closeMessage({ ...base, outcome: 'closed' }).text, /^Free RAM 123\.4 GB → 99\.9 GB; Firefox held 64\.2 GB\./, 'free RAM that fell (others took it) says what Firefox held instead');
});

test('never a kill: the close code ends no process (no taskkill, Stop-Process, TerminateProcess, Kill or process.kill)', () => {
  const ts = fs.readFileSync(path.join(import.meta.dirname, '..', 'machine', 'firefox.ts'), 'utf8');
  const cs = fs.readFileSync(path.join(import.meta.dirname, '..', 'machine', 'tray', 'FFFactoryTray.cs'), 'utf8');
  const tray = cs.slice(cs.indexOf('void RefreshFirefox()'), cs.indexOf('static string Size('));
  assert.ok(tray.length > 100, 'the tray finds Firefox in RefreshFirefox');
  for (const [name, text] of [['machine/firefox.ts', ts], ['the tray RefreshFirefox', tray]] as const) {
    for (const bad of [/taskkill/i, /Stop-Process/i, /TerminateProcess/i, /\.Kill\s*\(/, /process\.kill/, /kill\s+-9/, /WM_QUIT|0x0012/]) assert.doesNotMatch(text, bad, `${name} has ${bad}`);
  }
  assert.match(ts, /PostMessage\(h, 0x0010,/, 'WM_CLOSE, posted, as the title bar X');
});

test('a profile: open only while its parent.lock is held; once closed, prefs.js gains the restore-once line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-firefox-'));
  assert.equal(profileInUse(dir), false, 'no parent.lock');
  fs.writeFileSync(path.join(dir, 'parent.lock'), '');
  assert.equal(profileInUse(dir), false, 'a parent.lock nobody holds (Firefox leaves the file when it ends)');
  assert.throws(() => resumeOnce(dir), /no prefs\.js/, 'a profile never used is not written to');
  fs.writeFileSync(path.join(dir, 'prefs.js'), '// Mozilla User Preferences\nuser_pref("browser.startup.page", 1);');
  resumeOnce(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'prefs.js'), 'utf8'), `// Mozilla User Preferences\nuser_pref("browser.startup.page", 1);\n${RESUME_PREF}\n`);
});

test('Windows for real: the list from CIM; windows closed one at a time by WM_CLOSE; one that stays stops it; no kill', { skip: process.platform !== 'win32' && 'Windows only', timeout: 180_000 }, async () => {
  // Two windows standing in for Firefox's, in a process that ends by itself when both have closed (or after 120 s). The top
  // one refuses its first close, as a window showing a prompt stays open.
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$script:n = 0; $script:refused = 0
function New-Win($t) { $f = New-Object System.Windows.Forms.Form; $f.Text = $t; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(-3000, -3000); $f.Add_FormClosed({ $script:n++; if ($script:n -ge 2) { [System.Windows.Forms.Application]::ExitThread() } }); $f }
$a = New-Win 'ff-firefox-test-a'
$b = New-Win 'ff-firefox-test-b'
$b.Add_FormClosing({ param($s, $e) if ($env:FF_REFUSE -eq '1' -and $script:refused -eq 0) { $script:refused = 1; $e.Cancel = $true } })
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 120000; $t.Add_Tick({ [System.Windows.Forms.Application]::ExitThread() }); $t.Start()
$a.Show(); $b.Show(); $b.Activate()
[Console]::Out.WriteLine('up'); [Console]::Out.Flush()
[System.Windows.Forms.Application]::Run()`;
  const windowsUp = async (refuse: boolean) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, FF_REFUSE: refuse ? '1' : '0' } });
    const exited = new Promise<number | null>((res) => p.on('exit', (code) => res(code)));
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('the test windows did not come up')), 60_000);
      p.stdout.on('data', (d: Buffer) => d.toString().includes('up') && (clearTimeout(timer), res()));
    });
    return { pid: p.pid!, exited };
  };
  const CLS = 'WindowsForms10.';

  // A prompt: the first window stays open through the wait, so the second is never asked; asked again, both close.
  const stubborn = await windowsUp(true);
  assert.equal(await winCountWindows(stubborn.pid, CLS), 2);
  assert.equal(await winCountWindows(stubborn.pid, 'NoSuchClass'), 0, 'a window of another class is not counted or asked');
  assert.deepEqual(await winCloseWindows(stubborn.pid, 3000, { cls: CLS, settleMs: 200 }), { windows: 2, closed: 0, stuck: true });
  assert.equal(await winCountWindows(stubborn.pid, CLS), 2, 'both still open: the one that stayed, and the one never asked');
  assert.deepEqual(await winCloseWindows(stubborn.pid, 20_000, { cls: CLS, settleMs: 200 }), { windows: 2, closed: 2, stuck: false });
  assert.equal(await stubborn.exited, 0, 'it ended on its own, with code 0');

  // The whole close, with the real list and windows: closed, and the process ends by itself.
  const w = await windowsUp(false);
  const list = await winListFirefox('powershell.exe');
  const me = list.procs.find((x) => x.pid === w.pid);
  assert.ok(me, `the test windows' process is listed (${list.procs.length} powershell.exe)`);
  assert.equal(me.session, list.session, 'in this session');
  assert.ok(me.privateBytes > 1e6 && me.workingSet > 1e6, `its memory: ${me.privateBytes} private, ${me.workingSet} working set`);
  const r = await closeFirefox(
    {
      list: () => winListFirefox('powershell.exe'),
      closeWindows: (pid, waitMs) => winCloseWindows(pid, waitMs, { cls: CLS, settleMs: 200 }),
      freeMem: () => os.freemem(),
      profileDirs: () => [],
      inUse: () => false,
      resumeOnce: () => assert.fail('no profile here'),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      now: () => Date.now(),
    },
    { pids: [w.pid], waitMs: 30_000, childWaitMs: 1000, pollMs: 500 },
  );
  assert.equal(r.outcome, 'closed', JSON.stringify(r));
  assert.equal(r.windows, 2);
  assert.equal(await w.exited, 0, 'the process ended on its own, with code 0');
});

test('off by default (lothsahn: "Closing Firefox should be off by default"): nothing closes until the machine turns it on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-firefox-setting-'));
  const file = firefoxFile(dir);
  const sent: Record<string, unknown>[] = [];
  let closes = 0;
  let release = () => {};
  const facts = { outcome: 'closed' as const, windows: 1, instances: 1, closedInstances: 1, left: [], freeBefore: GB, freeAfter: 2 * GB, firefoxBytes: GB, resumed: ['p'], waitedMs: 3000 };
  const done: CloseResult = { ...facts, ...closeMessage(facts) };
  const make = () =>
    new FirefoxCloser({
      file,
      close: () => {
        closes++;
        return new Promise((res) => (release = () => res(done)));
      },
      send: (m) => sent.push(m),
      log: () => {},
    });
  const c = make();
  assert.equal(c.enabled, false, 'no firefox.json: off');
  assert.equal(await c.request(), undefined);
  assert.equal(closes, 0, 'off: Firefox is not touched');
  assert.deepEqual(sent.map((m) => m.title ?? m.state), ['Closing Firefox is off', 'idle']);
  for (const bad of ['', '{', '{"enabled":"yes"}', '{"enabled":1}']) {
    fs.writeFileSync(file, bad);
    assert.equal(readFirefoxEnabled(file), false, `${JSON.stringify(bad)} is off`);
  }
  c.setEnabled(true);
  assert.equal(make().enabled, true, 'kept in firefox.json across a daemon restart');
  sent.length = 0;
  const first = c.request();
  assert.equal(await c.request(), undefined, 'a second click while the first runs does nothing');
  release();
  assert.equal((await first)?.outcome, 'closed');
  assert.equal(closes, 1);
  assert.deepEqual(sent.map((m) => m.title ?? m.state), ['closing', 'Firefox closed', 'idle']);
  c.setEnabled(false);
  assert.equal(readFirefoxEnabled(file), false);
});

test('closing only some (pids): a profiles.ini profile another Firefox holds is never written, even if it closes meanwhile', async () => {
  const procs = [proc(100, 7, { commandLine: 'firefox.exe -profile C:\mine' }), proc(200, 7)];
  const { deps, calls } = pc({ procs, exitAfter: { 100: 1, 200: 1 }, profiles: ['P#200'], held: ['C:\mine', 'P#200'] });
  const r = await closeFirefox(deps, { pids: [100] });
  assert.deepEqual(r.resumed, ['C:\mine']);
  assert.ok(!calls.includes('resume P#200'));
});
