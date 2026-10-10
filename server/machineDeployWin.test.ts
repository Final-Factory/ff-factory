import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import * as win from './machineDeployWin.ts';
import { bundle, daemonConfig, macControlScript, parseWinProbe, pickRepo, platformOfUname, probeSlug } from './machineDeploy.ts';
import { SSH_REACHABLE_ARGS, daemonLogPath, machineForPath } from './machines.ts';
import { checkShell } from './guard.ts';
import { keepAwakeCommand } from '../machine/daemon.ts';
import { editorBinary, editorLogPath, editorTree, editorsFor, parseWinProcs, reportersFor, winLaunchScript } from '../machine/unity.ts';
import { ROOT } from './config.ts';

// Windows machines (docs/machines.md, "Windows machines"): the scripts the portal sends over ssh, the platform
// branching, and (on a Windows CI runner only) the scripts run for real by Windows PowerShell.

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const decode = (b64: string) => Buffer.from(b64, 'base64');
/** The base64 blobs Write-B64 writes in an install script, by file name. */
const blobs = (script: string) => Object.fromEntries([...script.matchAll(/Write-B64 '([^']+)' '([A-Za-z0-9+/=]+)'/g)].map((m) => [m[1], decode(m[2])]));

test('windows: the ssh command line is the same under cmd.exe and PowerShell (no quotes, no $, no &)', () => {
  const argv = win.psCommand();
  assert.equal(argv[0], 'powershell.exe');
  for (const a of argv) assert.match(a, /^[\w.=+/-]+$/, `"${a.slice(0, 40)}" would be read differently by the two shells`);
  const encoded = argv[argv.indexOf('-EncodedCommand') + 1];
  assert.equal(decode(encoded).toString('utf16le'), win.BOOTSTRAP);
  assert.match(win.BOOTSTRAP, /OpenStandardInput/);
  assert.equal(win.DATA_MARK.length, 9, 'the bootstrap splits the payload off 9 characters after the mark');
});

test('windows: every script is plain PowerShell (no template leftovers) and single-quotes what it embeds', () => {
  const node = "C:\\Users\\O'Brien\\AppData\\Roaming\\nvm\\v24.1.0\\node.exe";
  const scripts = {
    probe: win.probeScript('Some-Org/Some.Game'),
    upload: win.uploadScript(),
    uploadFile: win.uploadScript(undefined, '.ff-factory-upload-1.tgz'),
    npm: win.npmScript(node, 'abc1234'),
    supervisor: win.supervisorScript(node, false),
    install: win.installScript({ sid: SID, home: 'C:\\Users\\Ben', config: '{}', node, flag: false }),
    start: win.controlScript('start'),
    stop: win.controlScript('stop'),
    restart: win.controlScript('restart'),
    uninstall: win.uninstallScript(),
  };
  for (const [name, s] of Object.entries(scripts)) {
    assert.doesNotMatch(s, /undefined|\[object |\$\{/, `${name}: a TypeScript value leaked into the script`);
  }
  assert.match(scripts.probe, /\$slug = 'Some-Org\/Some\.Game'/);
  assert.throws(() => win.probeScript("x/y'; Remove-Item C:\\"), /not an owner\/name repo slug/);
  assert.match(scripts.npm, /Split-Path -Parent 'C:\\Users\\O''Brien\\/, "an apostrophe in a path is doubled inside '...'");
  assert.match(scripts.supervisor, /\$node = 'C:\\Users\\O''Brien\\/);
  // Probe: platform, user SID for the task, the newest node from PATH and the usual installers, a native claude.exe.
  for (const k of ["'platform' 'win32'", "'sid'", 'nvm', 'Volta', 'fnm', 'scoop', 'claude.exe', "'repo'"]) assert.ok(scripts.probe.includes(k), `probe: ${k}`);
  // Stop, then start: in that order; stop alone does not start; start alone does not stop.
  assert.ok(scripts.restart.indexOf('Stop-FFDaemon)') < scripts.restart.indexOf('Start-FFDaemon;'));
  assert.doesNotMatch(scripts.stop, /Start-FFDaemon;/);
  assert.doesNotMatch(scripts.start, /'stopped=' \+/);
  assert.match(scripts.uninstall, /Unregister-ScheduledTask -TaskName 'FFFactoryDaemon'/);
});

test('windows: scripts are pure ASCII even for a user named Björn (the input may be re-encoded under a PowerShell default shell)', () => {
  assert.equal(win.psq("O'Brien"), "'O''Brien'");
  assert.equal(win.psq('C:\\Users\\Björn\\n.exe'), "([string]'C:\\Users\\Bj' + [char]0x00F6 + 'rn\\n.exe')");
  assert.equal(win.psq('ü😀'), '([string][char]0x00FC + [char]0xD83D + [char]0xDE00)', 'beyond the BMP: both UTF-16 halves');
  const node = 'C:\\Users\\Björn\\nodejs\\node.exe';
  const config = daemonConfig({ portalUrl: 'https://p.example', id: 'b', token: 't', repoPath: 'D:\\Spiele\\FinalFactory-ä' });
  for (const s of [win.npmScript(node, 'v'), win.installScript({ sid: SID, home: 'C:\\Users\\Björn', config, node, flag: false }), win.probeScript('a/b'), win.BOOTSTRAP]) {
    assert.match(s, /^[\x00-\x7f]*$/, 'a character beyond ASCII in a script');
  }
  const p = parseWinProbe(`home~b64=${Buffer.from('C:\\Users\\Björn').toString('base64')}\nrepo~b64=${Buffer.from('D:\\Spiele\\FF-ä').toString('base64')}\nrepo=D:\\x\n`);
  assert.equal(p.home, 'C:\\Users\\Björn');
  assert.deepEqual(p.repos, ['D:\\Spiele\\FF-ä', 'D:\\x']);
  assert.match(win.BOOTSTRAP, /Replace\(\[string\]\[char\]13 \+ \[char\]10, \[string\]\[char\]10\)/, 'CRLF from an outer PowerShell back to LF');
  assert.match(win.BOOTSTRAP, /no script arrived on stdin'\); exit 3/);
});

test('windows: the stop spares the Unity editor and Hub (the user\'s), and holds the task off while it kills', () => {
  const s = win.controlScript('stop');
  assert.match(s, /-notmatch '\^Unity\( Hub\)\?\\\.exe\$'/, 'Unity and Unity Hub and their children are left running');
  assert.ok(s.indexOf('Disable-ScheduledTask') < s.indexOf('Stop-Process -Id') && s.indexOf('Stop-Process -Id') < s.indexOf('Enable-ScheduledTask'), 'disabled while killing, so restart-on-failure cannot bring it back');
  assert.match(s, /'app\\machine\\daemon\.ts'/);
  assert.match(s, /run-daemon\.ps1/);
});

/** Windows PowerShell on Windows, else PowerShell 7 when installed (GitHub's Ubuntu runners have it): for script functions fed made-up input. */
const powershell = process.platform === 'win32' ? 'powershell.exe' : ['/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh', '/snap/bin/pwsh'].find((p) => fs.existsSync(p));

test('windows (real PowerShell): the stop walks to real children only; a process whose dead parent\'s id was reused is not one (w906)', { skip: !powershell && 'no PowerShell here' }, () => {
  // wininit.exe as on a GitHub runner: started at boot, its parent's id long free, then drawn by the daemon stand-in.
  const procs = [
    { ProcessId: 748, ParentProcessId: 600, Name: 'node.exe', CommandLine: 'node C:\\ff\\app\\machine\\daemon.ts', At: '2026-10-10T18:00:10Z' },
    { ProcessId: 760, ParentProcessId: 748, Name: 'node.exe', CommandLine: 'node -e shell', At: '2026-10-10T18:00:11Z' },
    { ProcessId: 764, ParentProcessId: 760, Name: 'conhost.exe', CommandLine: 'conhost.exe 0x4', At: '2026-10-10T18:00:11Z' },
    { ProcessId: 770, ParentProcessId: 748, Name: 'node.exe', CommandLine: 'node C:\\ff\\app\\machine\\agentHost.ts x', At: '2026-10-10T18:00:12Z' },
    { ProcessId: 772, ParentProcessId: 748, Name: 'Unity.exe', CommandLine: 'Unity.exe -projectPath D:\\FF', At: '2026-10-10T18:00:12Z' },
    { ProcessId: 860, ParentProcessId: 748, Name: 'wininit.exe', CommandLine: '', At: '2026-10-10T07:00:01Z' },
    { ProcessId: 976, ParentProcessId: 860, Name: 'services.exe', CommandLine: '', At: '2026-10-10T07:00:02Z' },
    { ProcessId: 6316, ParentProcessId: 976, Name: 'Runner.Worker.exe', CommandLine: 'Runner.Worker.exe spawnclient', At: '2026-10-10T17:59:00Z' },
  ];
  const run = (agents: boolean) => {
    const script = `${win.KILL_SET}
$all = @(ConvertFrom-Json $env:FF_PROCS | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; CreationDate = [datetime]::Parse($_.At).ToUniversalTime() } })
(Get-FFKillSet $all @('C:\\ff\\app\\machine\\daemon.ts') @('C:\\ff\\app\\machine\\agentHost.ts') $${agents ? 'true' : 'false'}) -join ','`;
    return execFileSync(powershell!, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FF_PROCS: JSON.stringify(procs) }, encoding: 'utf8' }).trim();
  };
  assert.equal(run(false), '748,760,764', 'the daemon, its shell and the shell\'s console; not the agent host, Unity, nor wininit and the runner below it');
  assert.equal(run(true), '748,760,770,764', 'a stop with -Agents takes the host too');
});

test('windows: the task runs at logon of this user, in their session, not elevated, at normal priority, forever', () => {
  const x = win.taskXml(SID, 'C:\\Users\\A&B\\');
  assert.match(x, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>S-1-5-21-[\d-]+<\/UserId>/);
  assert.match(x, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(x, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(x, /<Priority>4<\/Priority>/, "a task's default priority 7 is below normal, inherited by every agent and Unity");
  assert.match(x, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(x, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>\s*<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(x, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(x, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>/);
  assert.match(x, /-WindowStyle Hidden -File "C:\\Users\\A&amp;B\\\.ff-factory\\run-daemon\.ps1"<\/Arguments>/, 'the path is XML-escaped and has no doubled slash');
  // w603: under Windows Terminal as the default terminal -WindowStyle Hidden leaves a window open; a headless conhost has none.
  assert.match(x, /<Command>conhost\.exe<\/Command>\s*<Arguments>--headless powershell\.exe -NoProfile /);
  assert.match(x, /<WorkingDirectory>C:\\Users\\A&amp;B\\\.ff-factory<\/WorkingDirectory>/);
  assert.throws(() => win.taskXml('Ben', 'C:\\Users\\Ben'), /not a Windows SID/);
});

test('windows: the install writes daemon.json without a BOM, the supervisor with one, and registers then starts the task', () => {
  const config = daemonConfig({ portalUrl: 'https://beast.tail.ts.net', id: 'lothdesktop', token: 'ffm_lothdesktop_x', repoPath: 'D:\\Games\\FinalFactory', claude: 'C:\\Users\\L\\.local\\bin\\claude.exe' });
  const s = win.installScript({ sid: SID, home: 'C:\\Users\\L', config, node: 'C:\\Program Files\\nodejs\\node.exe', flag: true });
  const b = blobs(s);
  assert.deepEqual(Object.keys(b).sort(), ['daemon.json', 'run-daemon.ps1']);
  assert.notEqual(b['daemon.json'][0], 0xef, 'JSON.parse refuses a BOM');
  assert.deepEqual(JSON.parse(b['daemon.json'].toString('utf8')), JSON.parse(config));
  assert.deepEqual([...b['run-daemon.ps1'].subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Windows PowerShell reads a BOM-less script as ANSI');
  const sup = b['run-daemon.ps1'].subarray(3).toString('utf8');
  assert.equal(sup, win.supervisorScript('C:\\Program Files\\nodejs\\node.exe', true));
  assert.match(sup, /--experimental-strip-types --disable-warning=ExperimentalWarning/);
  const xml = /FromBase64String\('([A-Za-z0-9+/=]+)'\)\)/.exec(s)?.[1];
  assert.equal(decode(xml!).toString('utf8'), win.taskXml(SID, 'C:\\Users\\L'));
  const order = ['Stop-FFDaemon', 'Move-Retry $new $app', "Write-B64 'daemon.json'", 'Register-ScheduledTask', 'Test-FFLoggedOn) { Start-FFDaemon'].map((k) => s.indexOf(k));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), `install steps out of order: ${order}`);
});

test('windows: the supervisor finds its own folder, passes the config, restarts with backoff, and keeps the last run\'s logs', () => {
  const s = win.supervisorScript('C:\\nodejs\\node.exe', false);
  assert.match(s, /\$F = \$PSScriptRoot/, 'not $env:USERPROFILE: the folder it was written to');
  assert.match(s, /'--disable-warning=ExperimentalWarning' \+ ' "' \+ \$daemon \+ '" "' \+ \(Join-Path \$F 'daemon\.json'\)/);
  assert.doesNotMatch(s, /strip-types/);
  assert.match(s, /-WindowStyle Hidden -PassThru -RedirectStandardOutput/);
  assert.match(s, /\$delay = \[Math\]::Min\(\$delay \* 2, 300\)/);
  assert.match(s, /\.prev/);
});

test('windows: the probe output is parsed (CRLF too), and the shortest clone wins unless one was given', () => {
  const p = parseWinProbe(
    [
      'platform=win32',
      'home=C:\\Users\\Loth',
      'user=LOTHDESKTOP\\Loth',
      `sid=${SID}`,
      'os=Microsoft Windows 11 Pro 10.0.26100.0',
      'loggedOn=True',
      'tar=True',
      'node=C:\\Program Files\\nodejs\\node.exe',
      'nodev=24.1.0',
      'git=C:\\Program Files\\Git\\cmd\\git.exe',
      'repo=D:\\dev\\FinalFactory\\Copy\\FinalFactory',
      'repo=D:\\FinalFactory',
      '',
    ].join('\r\n'),
  );
  assert.equal(p.home, 'C:\\Users\\Loth');
  assert.equal(p.sid, SID);
  assert.equal(p.loggedOn, true);
  assert.equal(p.tar, true);
  assert.equal(p.nodeVersion, '24.1.0');
  assert.equal(p.claude, undefined);
  assert.deepEqual(p.repos, ['D:\\dev\\FinalFactory\\Copy\\FinalFactory', 'D:\\FinalFactory']);
  assert.equal(pickRepo(undefined, p.repos), 'D:\\FinalFactory');
  assert.equal(pickRepo('E:\\ff', p.repos), 'E:\\ff');
  assert.equal(pickRepo(undefined, []), undefined);
  assert.equal(parseWinProbe('loggedOn=False\n').loggedOn, false);
});

test('windows: a deploy that knows its clone does not search for one; the probe never calls a method on an empty pipeline (w424)', () => {
  // The portal's own host passes its base clone: no walk of the home folder and every drive (which on BEAST also
  // finds the live game's checkout).
  assert.equal(probeSlug({ repoPath: 'C:\\ffsb\\_base', repoSlug: 'Some-Org/SomeGame' }), '');
  assert.equal(probeSlug({ repoSlug: 'Some-Org/SomeGame' }), 'Some-Org/SomeGame');
  assert.equal(probeSlug({}), '');
  assert.match(win.probeScript(''), /\$slug = ''\nif \(\$git -and \$slug\)/, 'no slug: the search is skipped');
  // Windows PowerShell casts a pipeline with no output to $null, not '': `[string](& git ... | Select-Object -First
  // 1)` then .Trim() threw on BEAST for a repo without an origin, and the whole probe failed (2026-10-05).
  assert.doesNotMatch(win.probeScript('Some-Org/SomeGame'), /=\s*\[string\]\(&/);
});

test('windows (real PowerShell): a reinstall or restart stops the daemon and its other children but leaves the agent hosts and what they run; a stop or uninstall ends them too (w605)', { skip: process.platform !== 'win32' && 'Windows only', timeout: 3 * 60_000 }, async (t) => {
  // Only stand-ins of its own, under a throwaway folder, and a task name that does not exist: so it runs on any Windows
  // box, never touching the computer's real daemon (service.only: no other daemon folder is looked at).
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffwin-stop-'));
  const service = { task: 'FFW605StopTest', only: true };
  const daemonMark = path.join(appDir, 'app', 'machine', 'daemon.ts');
  const hostMark = path.join(appDir, 'app', 'machine', 'agentHost.ts');
  const out = path.join(appDir, 'pids.json');
  const keep = 'setInterval(() => {}, 1000)';
  // The daemon stand-in names daemon.ts; it starts a shell (a plain child, as the caffeinate holder is) and a detached
  // host naming agentHost.ts, whose agent is its own plain child.
  const host = `const a = require('child_process').spawn(process.execPath, ['-e', '${keep}'], { stdio: 'ignore' }); require('fs').writeFileSync(process.argv[2], String(a.pid)); ${keep}`;
  const daemon = `const { spawn } = require('child_process'); const [, daemonMark, out] = process.argv; const hostMark = require('path').join(require('path').dirname(daemonMark), 'agentHost.ts');
const shell = spawn(process.execPath, ['-e', '${keep}'], { stdio: 'ignore' });
const host = spawn(process.execPath, ['-e', ${JSON.stringify(host)}, hostMark, out + '.agent'], { detached: true, stdio: 'ignore' });
host.unref();
require('fs').writeFileSync(out, JSON.stringify({ daemon: process.pid, shell: shell.pid, host: host.pid })); ${keep}`;
  spawn(process.execPath, ['-e', daemon, daemonMark, out], { stdio: 'ignore', windowsHide: true, env: withoutCoverage() }).unref();
  const pids: number[] = [];
  t.after(() => {
    for (const p of pids) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        // gone
      }
    }
    fs.rmSync(appDir, { recursive: true, force: true });
  });
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  const end = Date.now() + 30_000;
  while (!(fs.existsSync(out) && fs.existsSync(out + '.agent')) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  const p = JSON.parse(fs.readFileSync(out, 'utf8')) as { daemon: number; shell: number; host: number };
  const agent = Number(fs.readFileSync(out + '.agent', 'utf8'));
  pids.push(p.daemon, p.shell, p.host, agent);

  const restart = await runPs(win.stopScript(false, appDir, service), { timeoutMs: 60_000 });
  assert.equal(restart.code, 0, restart.stderr);
  // The daemon and its shell, and the console hosts Windows gives console programs.
  assert.ok(Number(/stopped=(\d+)/.exec(restart.stdout)?.[1]) >= 2, restart.stdout);
  assert.deepEqual([alive(p.daemon), alive(p.shell)], [false, false], 'the daemon and its shell are stopped');
  // Gone, so out of the clean-up's list: Windows reuses ids, and a kill by a stale one ends a stranger (w906).
  pids.splice(0, 2);
  assert.deepEqual([alive(p.host), alive(agent)], [true, true], 'the agent host and its agent run on');

  // A stop (or the uninstall): the host too, though its daemon is gone and it is nobody's child any more.
  const stop = await runPs(win.stopScript(true, appDir, service), { timeoutMs: 60_000 });
  assert.equal(stop.code, 0, stop.stderr);
  assert.deepEqual([alive(p.host), alive(agent)], [false, false], 'a stop ends the host and its agent');
  pids.length = 0;
  assert.match(win.controlScript('stop'), /Stop-FFDaemon -Agents/);
  assert.match(win.uninstallScript(), /Stop-FFDaemon -Agents/);
  assert.match(win.controlScript('restart'), /\(Stop-FFDaemon\)/);
  assert.match(win.installScript({ sid: SID, home: 'C:\\Users\\Ben', config: '{}', node: 'C:\\n\\node.exe', flag: false }), /\$null = Stop-FFDaemon\n/);
});

test('windows (real PowerShell): the probe survives a repo without an origin, and without a slug it searches nothing',{ skip: process.platform !== 'win32' && 'Windows only' }, async (t) => {
  // Read-only, so it runs on any Windows box, not only CI: a throwaway home with the clone and a repo that has no
  // origin (as BEAST has), searched as the home folder; the drives' own repos may show up too and are ignored.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ffwin-probe-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const clone = path.join(home, 'games', 'SomeGame');
  const bare = path.join(home, 'scratch', 'no-origin');
  for (const d of [clone, bare]) execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', 'https://github.com/Some-Org/SomeGame.git']);
  const real = (x: string) => fs.realpathSync.native(x).toLowerCase();
  const probed = await runPs(win.probeScript('Some-Org/SomeGame'), { env: { USERPROFILE: home }, timeoutMs: 3 * 60_000 });
  assert.equal(probed.code, 0, probed.stderr);
  const p = parseWinProbe(probed.stdout);
  assert.ok(p.sid && p.node, probed.stdout);
  assert.ok(p.repos.map(real).includes(real(clone)), `the clone is found: ${p.repos.join(', ')}`);
  assert.ok(!p.repos.map(real).includes(real(bare)), 'the repo without an origin is skipped, not fatal');
  const known = await runPs(win.probeScript(''), { env: { USERPROFILE: home }, timeoutMs: 60_000 });
  assert.equal(known.code, 0, known.stderr);
  assert.deepEqual(parseWinProbe(known.stdout).repos, []);
  assert.ok(parseWinProbe(known.stdout).sid);
});

test('platform: uname tells a Mac or a Linux PC; a Windows PC fails it, or answers MINGW/MSYS when Git\'s tools are on its PATH', () => {
  assert.equal(platformOfUname('Darwin\n', 0), 'darwin');
  assert.equal(platformOfUname('MINGW64_NT-10.0-26100\n', 0), 'win32');
  assert.equal(platformOfUname('MSYS_NT-10.0-22631', 0), 'win32');
  assert.equal(platformOfUname('MINGW32_NT-10.0-26200', 0), 'win32');
  assert.equal(platformOfUname('CYGWIN_NT-10.0-26200', 0), 'win32');
  assert.equal(platformOfUname('UCRT64_NT-10.0-26200\n', 0), 'win32', 'any *_NT-<version> is Windows');
  assert.equal(platformOfUname('CLANG64_NT-10.0-26200', 0), 'win32');
  assert.equal(platformOfUname('MINGW64_NT-10.0-26200', 127), 'win32', 'even when the exit code is odd');
  assert.equal(platformOfUname('Darwin extra', 0), 'other', 'only an exact Darwin is a Mac');
  assert.equal(platformOfUname("'uname' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n", 1), undefined, 'cmd.exe: ask PowerShell next');
  assert.equal(platformOfUname('', 1), undefined);
  assert.equal(platformOfUname('Linux\n', 0), 'linux');
  assert.equal(platformOfUname('FreeBSD\n', 0), 'other');
});

test('platform: ssh reachability runs "exit 0", which cmd.exe and PowerShell run too ("true" is not a command there)', () => {
  assert.deepEqual(SSH_REACHABLE_ARGS('loth').slice(-3), ['loth', 'exit', '0']);
});

test('mac: start, stop, restart and uninstall of the LaunchAgent', () => {
  assert.match(macControlScript('start'), /launchctl print gui\/\$\(id -u\)\/com\.fffactory\.daemon .*\|\| launchctl bootstrap gui\/\$\(id -u\) "\$HOME\/Library\/LaunchAgents\/com\.fffactory\.daemon\.plist"/);
  assert.match(macControlScript('stop'), /launchctl bootout gui\/\$\(id -u\)\/com\.fffactory\.daemon/);
  assert.doesNotMatch(macControlScript('stop'), /rm -f/, 'a stop keeps the plist: the daemon loads again at the next login');
  assert.match(macControlScript('restart'), /kickstart -k gui\/\$\(id -u\)\/com\.fffactory\.daemon/);
  assert.match(macControlScript('uninstall'), /rm -f "\$HOME\/Library\/LaunchAgents\/com\.fffactory\.daemon\.plist"/);
  // w605: a stop or uninstall ends this daemon's agent hosts; a restart leaves them for the next daemon.
  assert.match(macControlScript('stop', 'com.fffactory.daemon', "/Users/o'b/ffw/daemon/"), /pkill -f '\/Users\/o'\\''b\/ffw\/daemon\/app\/machine\/agentHost\.ts' 2>\/dev\/null \|\| true/);
  assert.match(macControlScript('uninstall'), /pkill -f "\$HOME\/\.ff-factory\/app\/machine\/agentHost\.ts"/);
  assert.doesNotMatch(macControlScript('restart'), /pkill/);
});

test('daemon: keeps the machine awake with caffeinate on a Mac, SetThreadExecutionState on Windows, a logind inhibitor on Linux, nothing elsewhere', () => {
  assert.deepEqual(keepAwakeCommand('darwin', 42), ['caffeinate', '-i', '-w', '42']);
  const l = keepAwakeCommand('linux', 42)!;
  assert.equal(l[0], 'systemd-inhibit');
  assert.ok(l.includes('--what=idle:sleep'));
  assert.deepEqual(l.slice(-4), ['tail', '--pid=42', '-f', '/dev/null'], 'ends with the daemon, like caffeinate -w');
  assert.equal(keepAwakeCommand('freebsd', 42), undefined);
  const w = keepAwakeCommand('win32', 42)!;
  assert.equal(w[0], 'powershell.exe');
  const ps = decode(w[w.indexOf('-EncodedCommand') + 1]).toString('utf16le');
  assert.match(ps, /SetThreadExecutionState\(\[uint32\]2147483649\)/, 'ES_CONTINUOUS | ES_SYSTEM_REQUIRED');
  assert.match(ps, /Wait-Process -Id 42\b/, 'ends with the daemon, like caffeinate -w');
});

test('machines: a path under a Windows machine\'s clone or home is that machine\'s (any case, either slash); a Mac\'s exactly', () => {
  const ms = [
    { id: 'm5', repoPath: '/Users/ben/nevergames/FinalFactory', home: '/Users/ben', platform: undefined },
    { id: 'lothdesktop', repoPath: 'D:\\Games\\FinalFactory', home: 'C:\\Users\\Loth', platform: 'win32' as const },
  ];
  assert.equal(machineForPath('d:/games/finalfactory/Assets/Screenshots/a.png', ms)?.id, 'lothdesktop');
  assert.equal(machineForPath('C:\\Users\\Loth\\.ff-factory\\agents\\x\\b.png', ms)?.id, 'lothdesktop');
  assert.equal(machineForPath('C:\\Users\\Lothar\\b.png', ms), undefined, 'a prefix of a folder name is not the folder');
  assert.equal(machineForPath('/Users/ben/nevergames/FinalFactory/a.png', ms)?.id, 'm5');
  assert.equal(machineForPath('/users/ben/a.png', ms), undefined, "a Mac's paths compare exactly");
  assert.equal(machineForPath('F:\\ffsb\\slot1\\a.png', ms), undefined, "the host's own paths stay the host's");
  assert.match(daemonLogPath('win32'), /%USERPROFILE%\\\.ff-factory\\logs\\daemon\.log/);
  assert.match(daemonLogPath(undefined), /^~\/\.ff-factory\/logs\/daemon\.log$/);
});

test('guard on a Windows machine: its daemon (node.exe, the task) is off limits', () => {
  const ctx = { cwd: 'C:/Users/Loth/FinalFactory', gameRepos: [], remotes: () => [] } as unknown as Parameters<typeof checkShell>[1];
  for (const cmd of [
    'taskkill /IM node.exe /F',
    'taskkill /F /IM "claude.exe"',
    'Get-Process node | Stop-Process -Force',
    'Stop-Process -Name node',
    'schtasks /End /TN FFFactoryDaemon',
    'schtasks.exe /TN FFFactoryDaemon /Change /DISABLE',
    'Stop-ScheduledTask -TaskName FFFactoryDaemon',
    'Get-ScheduledTask FFFactoryDaemon | Unregister-ScheduledTask -Confirm:$false',
  ]) {
    assert.ok(checkShell(cmd, ctx), `should be refused: ${cmd}`);
  }
  for (const cmd of ['schtasks /Query /TN FFFactoryDaemon', 'Get-ScheduledTask FFFactoryDaemon']) {
    assert.equal(checkShell(cmd, ctx), undefined, `should be allowed: ${cmd}`);
  }
});

// ---- Unity on a Windows machine (machine/unity.ts)

const WREPO = 'D:\\Games\\FinalFactory';
const EDITOR = '"C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.1f1\\Editor\\Unity.exe"';
const wprocs = [
  { pid: 10, ppid: 1, cmd: `${EDITOR} -projectpath "d:\\games\\finalfactory" -useHub -hubIPC` },
  { pid: 11, ppid: 10, cmd: '"C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.1f1\\Editor\\Data\\Tools\\UnityShaderCompiler.exe" -port 1' },
  { pid: 12, ppid: 10, cmd: 'C:\\Windows\\system32\\conhost.exe 0x4' },
  { pid: 13, ppid: 10, cmd: '"D:\\Games\\FinalFactory\\Builds\\FinalFactory.exe" -host' },
  { pid: 14, ppid: 13, cmd: '"D:\\Games\\FinalFactory\\Builds\\FinalFactory_Data\\x.exe"' },
  { pid: 15, ppid: 10, cmd: '"C:\\Program Files\\nodejs\\node.exe" mcp.js' },
  { pid: 16, ppid: 10, cmd: `${EDITOR} -projectPath "D:\\Games\\FinalFactory_clone_0"` },
  { pid: 17, ppid: 1, cmd: `${EDITOR} -batchMode -projectPath D:\\Games\\FinalFactory -name AssetImportWorker0` },
  { pid: 18, ppid: 1, cmd: '"C:\\Program Files\\Unity Hub\\Unity Hub.exe"' },
  { pid: 19, ppid: 10, cmd: '"C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.1f1\\Editor\\UnityCrashHandler64.exe" --attach 10' },
  { pid: 20, ppid: 1, cmd: '"C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.1f1\\Editor\\Data\\Tools\\UnityBugReporter.exe" --project D:\\Games\\FinalFactory' },
];

test('windows unity: the editor with this clone open, in any case or slash, not a batch worker or another project', () => {
  assert.deepEqual(editorsFor(wprocs, WREPO, 'win32').map((p) => p.pid), [10]);
  assert.deepEqual(editorsFor(wprocs, 'd:/games/finalfactory/', 'win32').map((p) => p.pid), [10]);
  assert.deepEqual(editorsFor(wprocs, WREPO, 'darwin'), [], "a Mac's rules do not see Unity.exe");
  const t = editorTree(wprocs, 10, WREPO, 'win32');
  assert.deepEqual(t.kill.sort((a, b) => a - b), [10, 11, 12, 19]);
  assert.equal(t.spared.length, 3, `spared: ${t.spared.join('; ')}`);
  assert.ok(t.spared.some((s) => /FinalFactory \(a program it started\) \(pid 13\)/.test(s)), 'a game player it launched');
  assert.ok(t.spared.some((s) => /node\/claude \(pid 15\)/.test(s)));
  assert.ok(t.spared.some((s) => /another project's editor .*clone_0/.test(s)));
  assert.deepEqual(reportersFor(wprocs, WREPO, 'win32').map((p) => p.pid), [20], 'UnityCrashHandler64 runs beside every editor: not evidence');
});

test('windows unity: the editor binary from the Hub (a custom install folder first), its log, the process list and the launch', () => {
  const env = { ProgramFiles: 'C:\\Program Files', APPDATA: 'C:\\Users\\L\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\L\\AppData\\Local' };
  const files: Record<string, string> = {
    'D:\\Games\\FinalFactory/ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.1f1\n',
    'C:\\Users\\L\\AppData\\Roaming\\UnityHub\\secondaryInstallPath.json': '"E:\\\\Unity"',
  };
  const read = (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p];
  };
  const hit = (want: string) => (p: string) => p === want;
  assert.equal(editorBinary(WREPO, hit('E:\\Unity\\6000.3.1f1\\Editor\\Unity.exe'), read, 'C:\\Users\\L', 'win32', env), 'E:\\Unity\\6000.3.1f1\\Editor\\Unity.exe');
  assert.equal(editorBinary(WREPO, hit('C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.1f1\\Editor\\Unity.exe'), read, 'C:\\Users\\L', 'win32', env), 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.1f1\\Editor\\Unity.exe');
  assert.throws(() => editorBinary(WREPO, () => false, read, 'C:\\Users\\L', 'win32', env), /Unity 6000\.3\.1f1 is not installed in E:\\Unity or C:\\Program Files/);
  assert.equal(editorLogPath('win32', env), 'C:\\Users\\L\\AppData\\Local\\Unity\\Editor\\Editor.log');
  assert.deepEqual(parseWinProcs('{"pid":4,"ppid":0,"name":"System","cmd":""}'), [{ pid: 4, ppid: 0, cmd: 'System', name: 'System' }], 'ConvertTo-Json gives one object for one process');
  assert.deepEqual(parseWinProcs('[{"pid":1,"ppid":0,"name":"a.exe","cmd":"a.exe -x"},{"pid":2,"ppid":1,"name":"b.exe","cmd":null}]').map((p) => p.cmd), ['a.exe -x', 'b.exe']);
  // A command line with raw control characters (U+0000-U+001F) among ~90 KB of processes: read, not a failed watch.
  const many = Array.from({ length: 600 }, (_, i) => `{"pid":${i + 10},"ppid":1,"name":"p${i}.exe","cmd":"C:\\\\Tools\\\\p${i}.exe --a-long-argument-list-to-reach-the-size-seen-on-LothDesktop ${'x'.repeat(80)}"}`);
  const ctl = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join('');
  const listing = `[${many.join(',')},{"pid":9999,"ppid":1,"name":"Unity.exe","cmd":"Unity.exe -projectPath D:\\\\FF ${ctl}"}]`;
  assert.ok(listing.length > 88_189);
  const procs = parseWinProcs(listing, () => assert.fail('nothing to skip'));
  assert.equal(procs.length, 601);
  assert.equal(procs.at(-1)!.cmd, `Unity.exe -projectPath D:\\FF ${ctl}`);
  assert.equal(
    winLaunchScript("C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.1f1\\Editor\\Unity.exe", ['-projectPath', "D:\\Loth's Games\\FF"], "D:\\Loth's Games\\FF"),
    `(Start-Process -FilePath 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.1f1\\Editor\\Unity.exe' -ArgumentList '-projectPath "D:\\Loth''s Games\\FF"' -WorkingDirectory 'D:\\Loth''s Games\\FF' -PassThru).Id`,
  );
});

// ---- For real, on a Windows CI runner: Windows PowerShell runs the scripts (no ssh), in a throwaway home.
// Only in CI: this registers (and removes) a scheduled task and starts a daemon, which a developer's own
// Windows box (the portal host) must not get from a plain `npm test`.

const onWindowsCi = process.platform === 'win32' && process.env.CI === 'true';

/**
 * The environment for a process that starts a node of its own and later ends it (a daemon stand-in, the real daemon a
 * script starts). `node --test --experimental-test-coverage` sets NODE_V8_COVERAGE for the test file and every node below
 * it inherits it; one ended abruptly leaves its coverage file empty, and the runner then fails the whole run with
 * "coverage file is empty" though every test passed (w858: 2 of 20 shard runs on a Windows runner).
 *
 * Empty, not deleted: node's spawn copies NODE_V8_COVERAGE into any env that has no such key (lib/child_process.js,
 * copyProcessEnvToEnv), so a deleted one came straight back, and an empty one turns coverage off (w906: the probe's
 * `node -p`, ended by `Select-Object -First 1` as it wrote its coverage, was the empty file in every failed run).
 */
function withoutCoverage(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...env, NODE_V8_COVERAGE: '' };
}

test('withoutCoverage: a node started with it writes no coverage, though node copies NODE_V8_COVERAGE into every child (w906)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffwin-nocov-'));
  const before = process.env.NODE_V8_COVERAGE;
  process.env.NODE_V8_COVERAGE = before || dir;
  try {
    const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env.NODE_V8_COVERAGE ?? null))'], { env: withoutCoverage(), encoding: 'utf8' });
    assert.ok(out === '""' || out === 'null', `the child still has NODE_V8_COVERAGE=${out}`);
    assert.deepEqual(fs.readdirSync(dir), [], 'no coverage file');
  } finally {
    if (before === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Run a script the way psScript does over ssh, but locally: the same encoded bootstrap, fed on stdin. `shell`
 * stands in for sshd's default shell: sshd runs the command line through `cmd.exe /c` or `powershell.exe -c`.
 */
function runPs(script: string, opts: { data?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: 'cmd' | 'powershell'; raw?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const line = win.psCommand().join(' ');
    const [exe, ...args] = opts.shell === 'cmd' ? ['cmd.exe', '/c', line] : opts.shell === 'powershell' ? ['powershell.exe', '-c', line] : win.psCommand();
    const child = spawn(exe, args, { env: withoutCoverage(opts.env), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.replace(/\r\n/g, '\n'), stderr });
    });
    child.stdin.end(opts.raw ? script : win.stdinOf(script, opts.data));
  });
}

test('windows (real PowerShell): every script parses', { skip: !onWindowsCi && 'Windows CI only' }, () => {
  const node = process.execPath;
  const all = [
    win.BOOTSTRAP,
    win.probeScript('Some-Org/SomeGame'),
    win.uploadScript(),
    win.uploadScript('D:\\ff', '.ff-factory-upload-1.tgz'),
    win.npmScript(node, 'abc1234'),
    win.supervisorScript(node, true),
    win.installScript({ sid: SID, home: 'C:\\Users\\Ben', config: '{}', node, flag: false }),
    win.controlScript('restart'),
    win.uninstallScript(),
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffwin-parse-'));
  try {
    all.forEach((s, i) => fs.writeFileSync(path.join(dir, `${i}.ps1`), s));
    const check =
      "$bad = 0; Get-ChildItem -LiteralPath $env:FFDIR -Filter *.ps1 | ForEach-Object { $e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$t, [ref]$e); foreach ($x in $e) { $bad++; Write-Output ($_.Name + ': ' + $x.Message + ' at line ' + $x.Extent.StartLineNumber) } }; if ($bad) { exit 1 }";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { env: { ...process.env, FFDIR: dir }, encoding: 'utf8' });
    assert.equal(out.trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('windows (real PowerShell): the bootstrap runs a script from stdin with its payload, under cmd.exe and PowerShell as the shell, and fails loudly', { skip: !onWindowsCi && 'Windows CI only' }, async () => {
  const script = `$x = ${win.psq('Grüße')}\nif ($x.Length -eq 5) { 'name ok' }\n[Console]::Out.WriteLine('len=' + $FFData.Trim().Length + ' data=' + $FFData.Trim())`;
  for (const shell of [undefined, 'cmd', 'powershell'] as const) {
    const ok = await runPs(script, { data: 'QUJDRA==', shell });
    assert.equal(ok.code, 0, `${shell ?? 'direct'}: ${ok.stderr}`);
    assert.match(ok.stdout, /name ok/, `${shell ?? 'direct'}: a non-ASCII literal survives`);
    assert.match(ok.stdout, /len=8 data=QUJDRA==/, `${shell ?? 'direct'}: the payload arrives (${ok.stdout})`);
    const bad = await runPs("$ErrorActionPreference = 'Stop'\nthrow 'the script failed on purpose'", { shell });
    assert.notEqual(bad.code, 0, `${shell ?? 'direct'}: a failing script must not exit 0`);
    assert.match(bad.stderr + bad.stdout, /the script failed on purpose/);
  }
  const empty = await runPs('');
  assert.equal(empty.code, 3, 'nothing on stdin is an error, not a silent success');
  const nothing = await runPs('', { raw: true });
  assert.equal(nothing.code, 3, 'not even the end mark: an error too');
  const cut = await runPs("[Console]::Out.WriteLine('ran')", { raw: true });
  assert.equal(cut.code, 3, 'a script without its end mark was cut off on the way: not run');
  assert.doesNotMatch(cut.stdout, /ran/);
  assert.match(cut.stderr, /without its end mark/);
  // Larger than one 64 KB read, and with a payload: the bootstrap stops at the end mark, over several reads.
  const big = await runPs(`${'# padding\n'.repeat(9000)}[Console]::Out.WriteLine('big ok ' + $FFData.Trim().Length)`, { data: 'A'.repeat(200_000), shell: 'cmd' });
  assert.equal(big.code, 0, big.stderr);
  assert.match(big.stdout, /big ok 200000/);
});

test('windows: stdin is the script, the payload after DATA_MARK, then END_MARK (the bootstrap reads up to it, never to EOF)', () => {
  assert.equal(win.stdinOf('s'), 's\n#FFEND\n');
  assert.equal(win.stdinOf('s', 'QUJD'), 's\n#FFDATA\nQUJD\n#FFEND\n');
  assert.doesNotMatch(win.BOOTSTRAP, /CopyTo/, 'CopyTo waits for EOF, which never comes on some PCs past a few KB of stdin');
  assert.match(win.BOOTSTRAP, /EndsWith\('#FFEND'\)\) \{ break \}/);
});

test('remote failures say the exit code, whether the timeout killed it, and both output streams', () => {
  assert.equal(win.failureDetail({ code: -1, stdout: '', stderr: '', timedOut: true }), 'timed out and killed (code -1); no stderr; no stdout');
  assert.equal(win.failureDetail({ code: 1, stdout: 'a\nb\n', stderr: 'boom\n' }), 'exit code 1; stderr: boom; stdout: a | b');
});

test('windows (real PowerShell): probe, unpack, npm ci, install into an app_dir, the daemon says hello as win32, stop, uninstall', { skip: !onWindowsCi && 'Windows CI only', timeout: 12 * 60_000 }, async (t) => {
  // A user folder with a non-ASCII name, as a Björn would have.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ffwin-hömé-'));
  const env = { USERPROFILE: home };
  // The daemon's folder elsewhere than %USERPROFILE%\.ff-factory (add_machine app_dir, e.g. D:\work\.ff-factory).
  const appDir = path.join(home, 'work drive', '.ff-factory');
  t.after(async () => {
    await runPs(win.uninstallScript(appDir), { env });
    fs.rmSync(home, { recursive: true, force: true });
  });
  // A clone of the game repo in the throwaway home, found by its origin.
  const clone = path.join(home, 'nevergames', 'FinalFactory');
  fs.mkdirSync(clone, { recursive: true });
  execFileSync('git', ['init', '-q', clone]);
  execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', 'https://github.com/Some-Org/SomeGame.git']);

  // Under PowerShell as sshd's default shell, the harder of the two.
  const probed = await runPs(win.probeScript('Some-Org/SomeGame'), { env, timeoutMs: 5 * 60_000, shell: 'powershell' });
  assert.equal(probed.code, 0, probed.stderr);
  const p = parseWinProbe(probed.stdout);
  const real = (x: string) => fs.realpathSync.native(x).toLowerCase();
  assert.equal(real(p.home), real(home));
  assert.match(p.sid, /^S-1-5-/);
  assert.ok(p.node && p.nodeVersion, `no node found: ${probed.stdout}`);
  assert.ok(p.git, 'git found');
  assert.equal(p.tar, true);
  assert.deepEqual(p.repos.map(real), [real(clone)]);

  // The bundle as scp leaves it (a file), unpacked and then deleted.
  const tgz = path.join(home, '.ff-factory-upload-1.tgz');
  fs.writeFileSync(tgz, Buffer.from(await bundle(ROOT), 'base64'));
  const up = await runPs(win.uploadScript(appDir, tgz), { env, timeoutMs: 5 * 60_000, shell: 'powershell' });
  assert.equal(up.code, 0, up.stderr);
  assert.ok(fs.existsSync(path.join(appDir, 'app.new', 'machine', 'daemon.ts')));
  assert.ok(!fs.existsSync(tgz), 'the uploaded bundle is deleted after unpacking');

  const npm = await runPs(win.npmScript(p.node!, 'abc1234', appDir), { env, timeoutMs: 8 * 60_000 });
  assert.equal(npm.code, 0, npm.stderr || npm.stdout);
  assert.equal(fs.readFileSync(path.join(appDir, 'app.new', 'machine', 'VERSION'), 'utf8').trim(), 'abc1234');

  // A stand-in portal: the daemon must connect and say hello as a Windows machine.
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/machine' });
  t.after(() => wss.close());
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const hello = new Promise<Record<string, unknown>>((resolve) => wss.on('connection', (ws) => ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'hello') resolve(m);
  })));
  const portalUrl = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const config = daemonConfig({ portalUrl, id: 'lothdesktop', token: 'ffm_lothdesktop_' + 'x'.repeat(43), repoPath: clone, claude: p.claude, appDir });
  const inst = await runPs(win.installScript({ sid: p.sid, home, config, node: p.node!, flag: false, appDir }), { env, timeoutMs: 3 * 60_000 });
  assert.equal(inst.code, 0, inst.stderr);
  assert.match(inst.stdout, /started=(True|False)/);
  assert.ok(fs.existsSync(path.join(appDir, 'app', 'machine', 'daemon.ts')), 'app.new became app');
  assert.ok(!fs.existsSync(path.join(home, '.ff-factory')), 'nothing went to the default folder');
  assert.equal(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-ScheduledTask -TaskName '${win.TASK_NAME}').Principal.LogonType`], { encoding: 'utf8' }).trim(), 'Interactive');
  // The runner may have no desktop session (started=False), or one the task does not start in: then run the
  // supervisor as the task would.
  const within = <T,>(pr: Promise<T>, ms: number) => Promise.race([pr, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
  let h = /started=True/.test(inst.stdout) ? await within(hello, 30_000) : undefined;
  if (!h) {
    const sup = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(appDir, 'run-daemon.ps1')], { detached: true, stdio: 'ignore', windowsHide: true, env: withoutCoverage() });
    sup.unref();
    h = await within(hello, 90_000);
  }
  assert.ok(h, `no hello from the daemon; logs:\n${logs(appDir)}`);
  const info = h.info as { platform?: string; os?: string };
  assert.equal(info.platform, 'win32');
  assert.match(info.os ?? '', /^Windows/);

  const stop = await runPs(win.controlScript('stop', appDir), { env });
  assert.equal(stop.code, 0, stop.stderr);
  const n = Number(/stopped=(\d+)/.exec(stop.stdout)?.[1]);
  assert.ok(n >= 2, `the supervisor and the daemon were stopped (${stop.stdout.trim()})`);
});

function logs(appDir: string) {
  const dir = path.join(appDir, 'logs');
  try {
    return fs.readdirSync(dir).map((f) => `${f}: ${fs.readFileSync(path.join(dir, f), 'utf8').slice(-800)}`).join('\n');
  } catch {
    return '(none)';
  }
}
