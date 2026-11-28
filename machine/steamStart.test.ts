// w6727: the daemon's "start Steam in the desktop session" operation and the players broker's self-healing, against a
// pretend Windows computer (reg, tasklist, whoami, quser, explorer.exe and the direct start answered here; nothing of the host's is run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_BACKOFF_MS,
  AUTO_MAX,
  AUTO_WAIT_MS,
  AUTO_WINDOW_MS,
  MANUAL_WAIT_MS,
  SteamStarter,
  desktopCheck,
  resolveSteamExe,
  startSteam,
  steamEnv,
  steamStartMsgProblem,
  type SteamStartDeps,
} from './steamStart.ts';

const EXE = 'c:\\program files (x86)\\steam\\steam.exe';
const EXPLORER = 'C:\\Windows\\explorer.exe';
const WHOAMI = 'C:\\Windows\\System32\\whoami.exe';
const QUSER = 'C:\\Windows\\System32\\quser.exe';
const REG = 'C:\\Windows\\System32\\reg.exe';
const TASKLIST = 'C:\\Windows\\System32\\tasklist.exe';

interface World {
  installed: boolean;
  steamExe?: string;
  steamPath: string;
  running: boolean;
  accountId: number;
  level: string;
  session: number;
  /** The user of each Explorer in the daemon's session. */
  explorers: string[];
  /** quser's logged-in sessions: user and session id. */
  users: [string, number][];
  /** What a hand-off to Explorer does: Steam comes up signed in, or nothing happens. */
  onLaunch: 'up' | 'nothing' | 'throw';
  reporter: boolean;
  title?: string;
}

function world(over: Partial<World> = {}) {
  const w: World = { installed: true, steamPath: 'c:/program files (x86)/steam', running: false, accountId: 0, level: 'Medium', session: 1, explorers: ['BEAST\\rydin'], users: [['rydin', 1]], onLaunch: 'up', reporter: false, ...over };
  const calls: string[][] = [];
  const launches: string[][] = [];
  const logs: string[] = [];
  let t = Date.parse('2026-11-27T16:00:00Z');
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  const none = ok('INFO: No tasks are running which match the specified criteria.\r\n');
  const started = () => {
    if (w.onLaunch === 'throw') throw new Error('explorer exploded');
    if (w.onLaunch === 'up') (w.running = true), (w.accountId = 0x6d307f);
  };
  const d: SteamStartDeps = {
    platform: 'win32',
    home: 'C:\\Users\\rydin',
    now: () => new Date(t),
    sleep: async (ms) => void (t += ms),
    pid: 4242,
    user: 'rydin',
    systemRoot: 'C:\\Windows',
    spawnDetached: async (exe, cwd) => {
      launches.push(['spawn', exe, cwd]);
      started();
      return 999;
    },
    log: (l) => void logs.push(l),
    read: () => undefined,
    exists: (f) => w.installed && [EXE, `${w.steamPath}/steam.exe`].map((x) => x.toLowerCase().replace(/\//g, '\\')).includes(f.toLowerCase().replace(/\//g, '\\')),
    run: async (full, args) => {
      // Windows' own tools come by full path (steamStart.ts) or by name (steamClient.ts): both answer here.
      const cmd = ({ [REG]: 'reg', [TASKLIST]: 'tasklist' } as Record<string, string>)[full] ?? full;
      calls.push([cmd, ...args]);
      const a = args.join(' ');
      if (cmd === 'reg') {
        if (!w.installed) return { code: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' };
        if (a.includes('ActiveProcess')) return ok(`    ActiveUser    REG_DWORD    0x${w.accountId.toString(16)}\r\n`);
        return ok(`HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    ${w.steamPath}\r\n${w.steamExe !== undefined ? `    SteamExe    REG_SZ    ${w.steamExe}\r\n` : ''}`);
      }
      if (cmd === WHOAMI) return ok(`"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n"Mandatory Label\\${w.level} Mandatory Level","Label","S-1-16-8192",""\r\n`);
      if (cmd === QUSER) {
        if (!w.users.length) return { code: 1, stdout: '', stderr: 'No User exists for *\r\n' };
        const head = ' USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME\r\n';
        return ok(head + w.users.map(([u, id]) => `${id === w.session ? '>' : ' '}${u.padEnd(22)} console${' '.repeat(13)}${id}  Active      none   11/26/2026 11:40 AM`).join('\r\n'));
      }
      if (cmd === 'tasklist') {
        if (a.includes('PID eq 4242')) return ok(`"node.exe","4242","Console","${w.session}","90,000 K"\r\n`);
        if (a.includes('explorer.exe')) return w.explorers.length ? ok(w.explorers.map((u, i) => `"explorer.exe","${100 + i}","Console","${w.session}","50,000 K","Running","${u}","0:00:10","N/A"`).join('\r\n')) : none;
        if (a.includes('LogonUI.exe')) return none;
        if (a.includes('steamerrorreporter.exe')) return w.reporter ? ok('"steamerrorreporter.exe","77","Console","1","5,000 K","Running","BEAST\\rydin","0:00:00","Steam - Error"') : none;
        if (a.includes('steam.exe')) return w.running ? ok(`"steam.exe","555","Console","1","120,000 K"${args.includes('/V') ? `,"Running","BEAST\\rydin","0:00:05","${w.title ?? 'Steam'}"` : ''}`) : none;
      }
      if (cmd === EXPLORER) {
        launches.push([cmd, ...args]);
        started();
        return { code: 1, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command ${cmd} ${a}`);
    },
  };
  return { w, d, calls, launches, logs, advance: (ms: number) => void (t += ms), now: () => t };
}

test('w6727: a steam_start message may name no path, arguments or any other field', () => {
  assert.equal(steamStartMsgProblem({ type: 'steam_start', id: 'a1' }), undefined);
  assert.equal(steamStartMsgProblem({ type: 'steam_start', id: 'a1', why: "Lothsahn's orchestrator for w6727" }), undefined);
  for (const extra of [{ path: 'C:\\Windows\\System32\\cmd.exe' }, { args: ['-silent'] }, { exe: 'x' }, { cwd: 'C:\\' }, { command: 'calc' }]) {
    assert.match(steamStartMsgProblem({ type: 'steam_start', id: 'a1', ...extra }) ?? '', /takes no .*installed Steam client.*no arguments/, JSON.stringify(extra));
  }
  assert.match(steamStartMsgProblem({ type: 'steam_start', id: 'a1', why: 'x'.repeat(301) }) ?? '', /short text/);
});

test("w6727: the exe comes from Steam's own install record only, must be a steam.exe that exists", async () => {
  assert.deepEqual(await resolveSteamExe(world({ steamExe: 'c:/program files (x86)/steam/steam.exe' }).d), { exe: EXE });
  // A SteamExe that names another program is never started: SteamPath\steam.exe is.
  assert.deepEqual(await resolveSteamExe(world({ steamExe: 'c:/windows/system32/cmd.exe' }).d), { exe: EXE });
  assert.match(JSON.stringify(await resolveSteamExe(world({ installed: false }).d)), /not installed/);
  assert.match(JSON.stringify(await resolveSteamExe(world({ steamPath: 'relative/steam' }).d)), /names no steam.exe/);
});

test('w6727: started, Steam gets no arguments: the exe alone is handed to the desktop\'s Explorer', async () => {
  const x = world();
  const r = await startSteam(x.d, { waitMs: MANUAL_WAIT_MS, why: 'test' });
  assert.equal(r.state, 'started', r.said);
  assert.match(r.said, /signed in as account 7155839, connected/);
  assert.deepEqual(x.launches, [[EXPLORER, EXE]]);
  // Only reads besides that one hand-off: reg query, tasklist, whoami, quser.
  assert.deepEqual([...new Set(x.calls.map((c) => c[0]))].sort(), [EXPLORER, 'reg', 'tasklist', WHOAMI, QUSER].sort());
  assert.ok(x.calls.filter((c) => c[0] === 'reg').every((c) => c[1] === 'query'));
});

test('w6727: no Explorer shell in the logged-in session (it crashed): Steam is started directly, detached, with no arguments', async () => {
  const x = world({ explorers: [] });
  const r = await startSteam(x.d, { waitMs: MANUAL_WAIT_MS, why: 'test' });
  assert.equal(r.state, 'started', r.said);
  assert.deepEqual(x.launches, [['spawn', EXE, 'c:\\program files (x86)\\steam']]);
  assert.ok(x.logs.some((l) => /no Explorer shell runs in session 1; starting .*directly/.test(l)));
  // The direct start's environment keeps the user's own and drops FF Factory's and anything credential-like.
  const env = steamEnv({ PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\rydin', GH_TOKEN: 'x', FF_SESSION: 'y', ANTHROPIC_API_KEY: 'z', MY_SECRET: 's', NODE_OPTIONS: '--x' });
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'USERPROFILE']);
  // A direct start that cannot spawn is a bounded failure, never a throw.
  const y = world({ explorers: [] });
  y.d.spawnDetached = async () => {
    throw new Error('spawn EACCES');
  };
  const f = await startSteam(y.d, { waitMs: AUTO_WAIT_MS, why: 'test' });
  assert.equal(f.state, 'failed');
});

test('w6727: Steam already running: nothing is done, and it says so', async () => {
  const x = world({ running: true, accountId: 5 });
  const r = await startSteam(x.d, { waitMs: MANUAL_WAIT_MS, why: 'test' });
  assert.equal(r.state, 'already');
  assert.match(r.said, /already running .*nothing was done/);
  assert.deepEqual(x.launches, []);
  assert.ok(!x.calls.some((c) => c[0] === WHOAMI), 'not even the desktop is checked');
});

test('w6727: no desktop user, another user, session 0, Low or High integrity: refused with a clear message, nothing started', async () => {
  const cases: [Partial<World>, RegExp][] = [
    [{ users: [] }, /no user is logged in on this computer's desktop/],
    [{ users: [['rydin', 2]] }, /no user is logged in on this computer's desktop .*session 1/],
    [{ users: [['someone', 1]], explorers: ['BEAST\\someone'] }, /not rydin's/],
    [{ session: 0 }, /session 0 .*no user is logged in on the desktop/],
    [{ level: 'Low' }, /Low integrity.*registry not writable/],
    [{ level: 'High' }, /High integrity; .*never elevated/],
    [{ level: 'System' }, /System integrity/],
  ];
  for (const [over, said] of cases) {
    const x = world(over);
    const r = await startSteam(x.d, { waitMs: MANUAL_WAIT_MS, why: 'test' });
    assert.equal(r.state, 'refused', JSON.stringify(over));
    assert.match(r.said, said);
    assert.deepEqual(x.launches, [], JSON.stringify(over));
  }
  // An unreadable integrity level fails closed.
  const x = world();
  const run = x.d.run;
  x.d.run = async (cmd, args, o) => (cmd === WHOAMI ? { code: 1, stdout: '', stderr: 'denied' } : run(cmd, args, o));
  assert.match(JSON.stringify(await desktopCheck(x.d)), /could not be read/);
});

test('w6727: Steam that never comes up: one more hand-off, a bounded wait, a failure naming the crash reporter; never a throw', async () => {
  const x = world({ onLaunch: 'nothing', reporter: true });
  const t0 = x.now();
  const r = await startSteam(x.d, { waitMs: AUTO_WAIT_MS, why: 'test' });
  assert.equal(r.state, 'failed');
  assert.equal(x.launches.length, 2);
  assert.ok(x.now() - t0 <= AUTO_WAIT_MS + 5_000, 'bounded by the wait');
  assert.match(r.said, /did not start: after 2 start\(s\).*crash reporter is up.*never press Repair/);
  const y = world({ onLaunch: 'throw' });
  const e = await startSteam(y.d, { waitMs: AUTO_WAIT_MS, why: 'test' });
  assert.equal(e.state, 'failed');
  assert.match(e.said, /explorer exploded/);
});

test('w6727: a Steam that runs but stops at a dialog is reported with its window title, not clicked', async () => {
  const x = world({ title: 'Steam - Repair?' });
  x.d.run = ((run) => async (cmd: string, args: string[], o?: Parameters<typeof run>[2]) => {
    const r = await run(cmd, args, o);
    if (cmd === EXPLORER) x.w.accountId = 0; // up, but never signs in
    return r;
  })(x.d.run);
  const r = await startSteam(x.d, { waitMs: AUTO_WAIT_MS, why: 'test' });
  assert.equal(r.state, 'started');
  assert.match(r.said, /no account is signed in yet.*a Steam window "Steam - Repair\?".*left for a person/);
  assert.equal(x.launches.length, 1, 'a running Steam is not handed off again');
});

test('w6727 self-healing: a players launch starts a Steam that is not running, and goes on', async () => {
  const x = world();
  const s = new SteamStarter(x.d);
  assert.deepEqual(await s.beforePlayer('s1 in sb1'), { ok: true });
  assert.equal(x.launches.length, 1);
  assert.ok(x.logs.some((l) => /players launch for s1 in sb1, automatic try 1 of 4.*started/.test(l)), x.logs.join('\n'));
  // Running now: the next launch checks and does nothing.
  assert.deepEqual(await s.beforePlayer('s2 in sb1'), { ok: true });
  assert.equal(x.launches.length, 1);
});

test('w6727 self-healing: not Windows, Steam not installed, no desktop user: the player starts as before and no try is spent', async () => {
  const mac = world();
  mac.d.platform = 'darwin';
  assert.deepEqual(await new SteamStarter(mac.d).beforePlayer('s'), { ok: true });
  assert.deepEqual(mac.calls, []);
  const none = world({ installed: false });
  assert.deepEqual(await new SteamStarter(none.d).beforePlayer('s'), { ok: true });
  assert.deepEqual(none.launches, []);
  const nobody = world({ users: [] });
  const s = new SteamStarter(nobody.d);
  assert.deepEqual(await s.beforePlayer('s'), { ok: true });
  assert.deepEqual(nobody.launches, []);
  // Someone logs in: after the short re-check wait it is started.
  nobody.w.users = [['rydin', 1]];
  nobody.advance(AUTO_BACKOFF_MS[0]);
  assert.deepEqual(await s.beforePlayer('s'), { ok: true });
  assert.equal(nobody.launches.length, 1);
});

test('w6727 self-healing: a failed try refuses that launch clearly, backs off, and stops at the cap until Steam runs again', async () => {
  const x = world({ onLaunch: 'nothing' });
  const s = new SteamStarter(x.d);
  const first = await s.beforePlayer('s1 in sb1');
  assert.ok('refused' in first);
  assert.match(first.refused, /Steam is not running on this computer and the daemon's start of it failed.*next automatic try is after .*try 1 of 4.*ops_worker steam_start/);
  const launchesAfterFirst = x.launches.length;
  // Inside the back-off: no try, the player starts as before, and the log says why.
  assert.deepEqual(await s.beforePlayer('s2 in sb1'), { ok: true });
  assert.equal(x.launches.length, launchesAfterFirst);
  assert.ok(x.logs.some((l) => /last automatic try failed, the next is after/.test(l)));
  // Each back-off passed: tries 2, 3, 4, then no more in the window.
  for (let i = 0; i < AUTO_MAX - 1; i++) {
    x.advance(AUTO_BACKOFF_MS[Math.min(i, AUTO_BACKOFF_MS.length - 1)]);
    const r = await s.beforePlayer(`s${i + 3}`);
    assert.ok('refused' in r, `try ${i + 2}`);
  }
  const atCap = x.launches.length;
  x.advance(AUTO_BACKOFF_MS[AUTO_BACKOFF_MS.length - 1]);
  assert.deepEqual(await s.beforePlayer('late'), { ok: true });
  assert.equal(x.launches.length, atCap, 'no fifth try in the window');
  assert.ok(x.logs.some((l) => new RegExp(`${AUTO_MAX} automatic tries in 6 h failed`).test(l)));
  // A person starts it (or it comes back): the count resets.
  x.w.running = true;
  assert.deepEqual(await s.beforePlayer('ok'), { ok: true });
  x.w.running = false;
  x.w.onLaunch = 'up';
  assert.deepEqual(await s.beforePlayer('again'), { ok: true });
  assert.equal(x.launches.length, atCap + 1);
  // The window itself: tries older than it no longer count.
  assert.ok(AUTO_WINDOW_MS > AUTO_BACKOFF_MS.reduce((a, b) => a + b, 0));
});

test('w6727: launches and a person\'s start at the same time share one start', async () => {
  const x = world();
  const s = new SteamStarter(x.d);
  const [a, b, m] = await Promise.all([s.beforePlayer('a'), s.beforePlayer('b'), s.manual('Lothsahn')]);
  assert.deepEqual([a, b], [{ ok: true }, { ok: true }]);
  assert.ok(m.state === 'started' || m.state === 'already', m.said);
  assert.equal(x.launches.length, 1);
});

test('w6732 review: a launch that joins a start under way (a person\'s) waits at most AUTO_WAIT_MS', async () => {
  const x = world({ onLaunch: 'nothing' });
  const s = new SteamStarter(x.d);
  const t0 = x.now();
  const manual = s.manual('a person');
  let autoAt = 0;
  const auto = s.beforePlayer('s1 in sb1').then((r) => ((autoAt = x.now()), r));
  const [, a] = await Promise.all([manual, auto]);
  assert.deepEqual(a, { ok: true }, 'the player starts without waiting longer');
  assert.ok(autoAt - t0 < MANUAL_WAIT_MS, `the launch waited ${autoAt - t0} ms`);
  assert.ok(x.logs.some((l) => /under way did not finish in 45 s/.test(l)));
});

test('w6732 review: launches that share one failed start spend one try and count one failure', async () => {
  const x = world({ onLaunch: 'nothing' });
  const s = new SteamStarter(x.d);
  const [a, b] = await Promise.all([s.beforePlayer('s1 in sb1'), s.beforePlayer('s2 in sb2')]);
  assert.ok('refused' in a || 'refused' in b, 'the launch that began the start is refused clearly');
  const st = s as unknown as { autoFailures: number; autoTries: number[]; autoNextAt: number };
  assert.equal(st.autoFailures, 1);
  assert.equal(st.autoTries.length, 1);
  assert.ok(x.launches.length <= 2, `hand-offs: ${x.launches.length} (one start, handed off again once at most)`);
  assert.ok(st.autoNextAt - x.now() <= AUTO_BACKOFF_MS[0], 'the next try is the first backoff step');
});

test('w6732 review: a directly started Steam gets no credential-like variables', () => {
  const kept = steamEnv({ AWS_ACCESS_KEY_ID: 'a', STABILITY_KEY: 'b', SSH_PRIVATE_KEY: 'c', DISCORD_BOT_PAT: 'd', OPENAI_API_KEY: 'e', FF_DAEMON_TOKEN: 'f', KEYBOARD_LAYOUT: 'k', PATH: 'p' });
  assert.deepEqual(Object.keys(kept).sort(), ['KEYBOARD_LAYOUT', 'PATH']);
});
