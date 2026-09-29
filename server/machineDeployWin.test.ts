import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import * as win from './machineDeployWin.ts';
import { bundle, daemonConfig, macControlScript, parseWinProbe, pickRepo, platformOfUname } from './machineDeploy.ts';
import { SSH_REACHABLE_ARGS, daemonLogPath, machineForPath } from './machines.ts';
import { backupRecipe, checkShell } from './guard.ts';
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
  const config = daemonConfig({ portalUrl: 'https://p.example', id: 'b', token: 't', repoPath: 'D:\\Spiele\\FinalFactory-ä', maxSessions: 1 });
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
  assert.match(x, /<WorkingDirectory>C:\\Users\\A&amp;B\\\.ff-factory<\/WorkingDirectory>/);
  assert.throws(() => win.taskXml('Ben', 'C:\\Users\\Ben'), /not a Windows SID/);
});

test('windows: the install writes daemon.json without a BOM, the supervisor with one, and registers then starts the task', () => {
  const config = daemonConfig({ portalUrl: 'https://beast.tail.ts.net', id: 'lothdesktop', token: 'ffm_lothdesktop_x', repoPath: 'D:\\Games\\FinalFactory', claude: 'C:\\Users\\L\\.local\\bin\\claude.exe', maxSessions: 3 });
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

test('platform: uname tells a Mac; a Windows PC fails it, or answers MINGW/MSYS when Git\'s tools are on its PATH', () => {
  assert.equal(platformOfUname('Darwin\n', 0), 'darwin');
  assert.equal(platformOfUname('MINGW64_NT-10.0-26100\n', 0), 'win32');
  assert.equal(platformOfUname('MSYS_NT-10.0-22631', 0), 'win32');
  assert.equal(platformOfUname("'uname' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n", 1), undefined, 'cmd.exe: ask PowerShell next');
  assert.equal(platformOfUname('', 1), undefined);
  assert.equal(platformOfUname('Linux\n', 0), 'other');
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
});

test('daemon: keeps the machine awake with caffeinate on a Mac, SetThreadExecutionState on Windows, nothing elsewhere', () => {
  assert.deepEqual(keepAwakeCommand('darwin', 42), ['caffeinate', '-i', '-w', '42']);
  assert.equal(keepAwakeCommand('linux', 42), undefined);
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

test('guard on a Windows machine: its daemon (node.exe, the task) is off limits; Unity is not', () => {
  const ctx = { cwd: 'C:/Users/Loth/FinalFactory', ownMachine: true, gameRepos: [], remotes: () => [] } as unknown as Parameters<typeof checkShell>[1];
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
  for (const cmd of ['taskkill /IM Unity.exe /F', 'Stop-Process -Name "Unity Hub"', 'taskkill /F /IM UnityCrashHandler64.exe', 'schtasks /Query /TN FFFactoryDaemon', 'Get-ScheduledTask FFFactoryDaemon']) {
    assert.equal(checkShell(cmd, ctx), undefined, `should be allowed: ${cmd}`);
  }
});

test('guard: the backup recipe copies with rsync on a Mac and with tar on Windows (Git Bash has no rsync)', () => {
  const mac = backupRecipe('/Users/b/nevergames/ff-local-backups', 'darwin');
  assert.match(mac, /rsync -a --from0/);
  const w = backupRecipe('D:/Games/ff-local-backups', 'win32');
  assert.doesNotMatch(w, /rsync/);
  assert.match(w, /git ls-files -z -m -o --exclude-standard \| tar --null --ignore-failed-read -T - -cf - \| tar -xf - -C "\$b\/files"/);
  for (const r of [mac, w]) for (const k of ['unstaged.patch', 'staged.patch', 'stash-list.txt']) assert.ok(r.includes(k));
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
  assert.deepEqual(parseWinProcs('{"pid":4,"ppid":0,"name":"System","cmd":""}'), [{ pid: 4, ppid: 0, cmd: 'System' }], 'ConvertTo-Json gives one object for one process');
  assert.deepEqual(parseWinProcs('[{"pid":1,"ppid":0,"name":"a.exe","cmd":"a.exe -x"},{"pid":2,"ppid":1,"name":"b.exe","cmd":null}]').map((p) => p.cmd), ['a.exe -x', 'b.exe']);
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
 * Run a script the way psScript does over ssh, but locally: the same encoded bootstrap, fed on stdin. `shell`
 * stands in for sshd's default shell: sshd runs the command line through `cmd.exe /c` or `powershell.exe -c`.
 */
function runPs(script: string, opts: { data?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: 'cmd' | 'powershell' } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const line = win.psCommand().join(' ');
    const [exe, ...args] = opts.shell === 'cmd' ? ['cmd.exe', '/c', line] : opts.shell === 'powershell' ? ['powershell.exe', '-c', line] : win.psCommand();
    const child = spawn(exe, args, { env: { ...process.env, ...opts.env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.replace(/\r\n/g, '\n'), stderr });
    });
    child.stdin.end(opts.data === undefined ? script : script + win.DATA_MARK + opts.data);
  });
}

test('windows (real PowerShell): every script parses', { skip: !onWindowsCi && 'Windows CI only' }, () => {
  const node = process.execPath;
  const all = [
    win.BOOTSTRAP,
    win.probeScript('Some-Org/SomeGame'),
    win.uploadScript(),
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
});

test('windows (real PowerShell): probe, unpack, npm ci, install, the daemon says hello as win32, stop, uninstall', { skip: !onWindowsCi && 'Windows CI only', timeout: 12 * 60_000 }, async (t) => {
  // A user folder with a non-ASCII name, as a Björn would have.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ffwin-hömé-'));
  const env = { USERPROFILE: home };
  t.after(async () => {
    await runPs(win.uninstallScript(), { env });
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

  const up = await runPs(win.uploadScript(), { env, data: await bundle(ROOT), timeoutMs: 5 * 60_000, shell: 'powershell' });
  assert.equal(up.code, 0, up.stderr);
  assert.ok(fs.existsSync(path.join(home, '.ff-factory', 'app.new', 'machine', 'daemon.ts')));

  const npm = await runPs(win.npmScript(p.node!, 'abc1234'), { env, timeoutMs: 8 * 60_000 });
  assert.equal(npm.code, 0, npm.stderr || npm.stdout);
  assert.equal(fs.readFileSync(path.join(home, '.ff-factory', 'app.new', 'machine', 'VERSION'), 'utf8').trim(), 'abc1234');

  // A stand-in portal: the daemon must connect and say hello as a Windows machine.
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/machine' });
  t.after(() => wss.close());
  const hello = new Promise<Record<string, unknown>>((resolve) => wss.on('connection', (ws) => ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'hello') resolve(m);
  })));
  const portalUrl = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const config = daemonConfig({ portalUrl, id: 'lothdesktop', token: 'ffm_lothdesktop_' + 'x'.repeat(43), repoPath: clone, claude: p.claude, maxSessions: 1 });
  const inst = await runPs(win.installScript({ sid: p.sid, home, config, node: p.node!, flag: false }), { env, timeoutMs: 3 * 60_000 });
  assert.equal(inst.code, 0, inst.stderr);
  assert.match(inst.stdout, /started=(True|False)/);
  assert.ok(fs.existsSync(path.join(home, '.ff-factory', 'app', 'machine', 'daemon.ts')), 'app.new became app');
  assert.equal(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-ScheduledTask -TaskName '${win.TASK_NAME}').Principal.LogonType`], { encoding: 'utf8' }).trim(), 'Interactive');
  // The runner may have no desktop session (started=False), or one the task does not start in: then run the
  // supervisor as the task would.
  const within = <T,>(pr: Promise<T>, ms: number) => Promise.race([pr, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
  let h = /started=True/.test(inst.stdout) ? await within(hello, 30_000) : undefined;
  if (!h) {
    const sup = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(home, '.ff-factory', 'run-daemon.ps1')], { detached: true, stdio: 'ignore', windowsHide: true });
    sup.unref();
    h = await within(hello, 90_000);
  }
  assert.ok(h, `no hello from the daemon; logs:\n${logs(home)}`);
  const info = h.info as { platform?: string; os?: string };
  assert.equal(info.platform, 'win32');
  assert.match(info.os ?? '', /^Windows/);

  const stop = await runPs(win.controlScript('stop'), { env });
  assert.equal(stop.code, 0, stop.stderr);
  const n = Number(/stopped=(\d+)/.exec(stop.stdout)?.[1]);
  assert.ok(n >= 2, `the supervisor and the daemon were stopped (${stop.stdout.trim()})`);
});

function logs(home: string) {
  const dir = path.join(home, '.ff-factory', 'logs');
  try {
    return fs.readdirSync(dir).map((f) => `${f}: ${fs.readFileSync(path.join(dir, f), 'utf8').slice(-800)}`).join('\n');
  } catch {
    return '(none)';
  }
}
