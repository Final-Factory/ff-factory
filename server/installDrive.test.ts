import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { checkOffDriveScan, checkOutsideRootDelete, inNeverGames, installDrive, onInstallDrive, type RootFenceContext } from './rootFence.ts';
import { sandboxGuard } from './guard.ts';
import { cleanupRules, DEFAULT_CLEANUP, rulesOnInstallDrive } from './cleanup.ts';

/**
 * Windows: disk work reads, measures and deletes only on the install drive, never C: (w1755, lothsahn, 2026-10-22: "Your
 * worker on LothDesktop is still scanning c:  it should not.  You need to only look at v:.  Stop messing with my c:" and
 * "Fix the instructions for Windows boxes to only look at v:"). The refused cases are what w1754's clean-up worker ran on
 * LothDesktop (du over C:\Users\...\AppData and ~\.claude), in each shell's spelling.
 */

const LOTH: RootFenceContext = { root: 'V:\\ffw', cwd: 'V:\\ffw\\sandboxes\\slot1', allow: ['V:\\ffw\\sandboxes\\slot1'], home: 'C:\\Users\\loth' };
const BEAST: RootFenceContext = { root: 'F:\\ffw', cwd: 'F:\\ffw\\sandboxes\\slot4', allow: ['F:\\ffw\\sandboxes\\slot4'], home: 'C:\\Users\\rydin' };
const ON_C: RootFenceContext = { root: 'C:\\ffw', cwd: 'C:\\ffw\\sandboxes\\slot1', allow: ['C:\\ffw\\sandboxes\\slot1'], home: 'C:\\Users\\x' };
const MAC: RootFenceContext = { root: '/Users/Shared/ffw', cwd: '/Users/Shared/ffw/sandboxes/slot1', home: '/Users/loth' };
const LINUX: RootFenceContext = { root: '/home/ben-ryding/ffw', cwd: '/home/ben-ryding/ffw/sandboxes/slot1', home: '/home/ben-ryding' };

const refused = (cmd: string, ctx = LOTH) => assert.match(checkOffDriveScan(cmd, ctx) ?? '', /^Refused: /, cmd);
const fine = (cmd: string, ctx = LOTH) => assert.equal(checkOffDriveScan(cmd, ctx), undefined, cmd);

test('the install drive comes from the install folder, never a fixed letter', () => {
  assert.equal(installDrive('V:\\ffw'), 'v');
  assert.equal(installDrive('F:/ffw'), 'f');
  assert.equal(installDrive('/Users/Shared/ffw'), undefined);
  assert.equal(onInstallDrive('V:/ffw/tmp', 'V:\\ffw'), true);
  assert.equal(onInstallDrive('v:/other', 'V:\\ffw'), true);
  assert.equal(onInstallDrive('C:/Users/loth', 'V:\\ffw'), false);
  assert.equal(onInstallDrive('/c/Users/loth', 'V:\\ffw'), false);
  assert.equal(onInstallDrive('D:/data', 'V:\\ffw'), false);
  // A root on C: allows the folder itself, nothing else on C:.
  assert.equal(onInstallDrive('C:/ffw/tmp', 'C:\\ffw'), true);
  assert.equal(onInstallDrive('C:/Users/x', 'C:\\ffw'), false);
  assert.equal(onInstallDrive('C:/Users/x', '/home/x/ffw'), true);
});

test("what w1754's clean-up ran on LothDesktop's C: is refused, in Git Bash, PowerShell and cmd spellings", () => {
  refused('du -sh C:/Users/loth/AppData/*');
  refused('du -sh ~/.claude');
  refused('du -sh /c/Users/loth/AppData/Local | sort -h | tail -20');
  refused('du -sh "$HOME/.claude"');
  refused('Get-ChildItem C:\\Users\\loth\\AppData -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum');
  refused('gci -r $env:LOCALAPPDATA | measure Length -s');
  refused('Get-ChildItem -Path "$env:USERPROFILE\\.claude" -Recurse -File');
  refused('ls -R ~/AppData/LocalLow');
  refused('dir /s C:\\Users\\loth\\AppData');
  refused('cmd /c "dir /s /a C:\\ProgramData"');
  refused('find /c/Users/loth/.claude -type f -size +100M');
  refused('tree C:\\Users\\loth /f');
  refused('ncdu C:/');
  refused('cd C:/Users/loth && du -sh .');
  refused('cd ~ && du -sh *');
  refused('ff-leftovers check C:\\Users\\loth\\AppData\\Local\\Temp\\x');
  refused('powershell -Command "Get-ChildItem C:\\ -Recurse | Measure-Object"');
  // w1561's way to size a Windows folder.
  refused('robocopy C:\\Users\\loth\\AppData\\Local V:\\ffw\\tmp\\nothing /L /S /E /BYTES /NFL /NDL /NJH /NC /NP /R:0 /W:0 /XJ /MT:16');
  // Another drive is not the install drive either.
  refused('du -sh D:/data');
});

test('the message names the rule, who said it and what to do instead', () => {
  const msg = checkOffDriveScan('du -sh C:/Users/loth/AppData', LOTH)!;
  assert.match(msg, /off this Windows computer's install drive V: \(the install folder is V:\\ffw\)/);
  assert.match(msg, /reads, measures and deletes only on the install drive, never on C:/);
  assert.match(msg, /lothsahn, 2026-10-22, w1755: "Your worker on LothDesktop is still scanning c:/);
  assert.match(msg, /Measure inside V:\\ffw instead/);
  // BEAST's install drive is F:, from its own root.
  assert.match(checkOffDriveScan('du -sh ~/.claude', BEAST)!, /install drive F: \(the install folder is F:\\ffw\)/);
});

test('a scan on the install drive is allowed: the install folder, the sandbox, the temp folder, elsewhere on V:', () => {
  fine('du -sh V:/ffw/tmp/*');
  fine('du -sh /v/ffw/sandboxes/* | sort -h');
  fine('Get-ChildItem V:\\ffw\\sandboxes -Recurse -Directory | Measure-Object');
  fine('du -sh .');
  fine('du -sh');
  fine('du -sh "$TMPDIR"/*');
  fine('du -d 1 -h V:/ffw | sort -h');
  fine('find . -name "*.log" -size +10M');
  fine('dir /s V:\\ffw\\players');
  fine('ff-leftovers folders');
  fine('ff-leftovers list');
  fine('ff-leftovers check V:\\ffw\\tmp\\ffa-1234');
  fine('du -sh F:/ffw/tmp/*', BEAST);
  fine('robocopy V:\\ffw\\sandboxes V:\\ffw\\tmp\\nothing /L /S /E /BYTES /XJ');
  // A copy (no /L) is not a measurement.
  fine('robocopy C:\\x V:\\ffw\\tmp\\y file.txt');
  fine('du -sh V:/stuff');
  // Not a scan: a plain listing, a read of one file, free space.
  fine('ls C:/Users/loth');
  fine('Get-ChildItem C:\\Users\\loth\\AppData\\LocalLow');
  fine('df -h');
  // Unknown text is not judged.
  fine('du -sh "$SOMEDIR"');
});

test('a root on C: allows only the install folder; macOS and Linux are not judged here', () => {
  fine('du -sh C:/ffw/tmp/*', ON_C);
  refused('du -sh C:/Users/x/AppData', ON_C);
  refused('du -sh ~/.claude', ON_C);
  assert.equal(checkOffDriveScan('du -sh ~/Library/Caches', MAC), undefined);
  assert.equal(checkOffDriveScan('du -sh ~/.cache', LINUX), undefined);
});

test('the delete fence on Windows says the drive rule, not "measure and report"', () => {
  const msg = checkOutsideRootDelete('rm -rf /c/Users/loth/AppData/Local/Temp/x', LOTH)!;
  assert.match(msg, /On this Windows computer disk work stays on the install drive \(V:\): never read, measure or touch C:/);
  assert.doesNotMatch(msg, /measure and report/);
  assert.match(checkOutsideRootDelete('rm -rf ~/Library/Caches/x', MAC)!, /measure and report sizes/);
});

test('the sandbox guard refuses a C: scan on a Windows worker root and allows the install drive', async () => {
  const guard = sandboxGuard({ sandboxId: 'lothdesktop/slot1', sandboxPath: 'V:\\ffw\\sandboxes\\slot1', protectedPaths: [], workerRoot: 'V:\\ffw' });
  const run = async (tool: 'Bash' | 'PowerShell', command: string) =>
    (
      (await guard({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: 'V:\\ffw\\sandboxes\\slot1' } as never, 'x', {
        signal: new AbortController().signal,
      })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
    ).hookSpecificOutput;
  const no = await run('Bash', 'du -sh C:/Users/loth/AppData/*');
  assert.equal(no?.permissionDecision, 'deny');
  assert.match(no?.permissionDecisionReason ?? '', /w1755/);
  assert.equal((await run('PowerShell', 'Get-ChildItem C:\\Users\\loth -Recurse | Measure-Object -Sum Length'))?.permissionDecision, 'deny');
  assert.notEqual((await run('Bash', 'du -sh V:/ffw/tmp/*'))?.permissionDecision, 'deny');
  assert.notEqual((await run('PowerShell', 'Get-ChildItem V:\\ffw\\sandboxes -Recurse | Measure-Object'))?.permissionDecision, 'deny');
});

/**
 * The one exception on C:: the game's data folders under AppData may be read, never modified (w1755, lothsahn, 2026-10-22:
 * "Let's let it scan the never games folder, but not the rest of C.  And it shouldn't modify it." and "By never games I mean
 * in appdata").
 */
const NG = 'C:\\Users\\loth\\AppData\\LocalLow\\Never Games';

test("Never Games under any profile's AppData is the exception; nothing else on C: is", () => {
  const home = 'C:\\Users\\loth';
  assert.equal(inNeverGames(NG, home), true);
  assert.equal(inNeverGames('C:/Users/loth/AppData/LocalLow/Never Games/finalfactory/UserData/saves/x.zip', home), true);
  assert.equal(inNeverGames('c:/users/loth/appdata/local/never games', home), true);
  assert.equal(inNeverGames('/c/Users/loth/AppData/Roaming/Never Games/x', home), true);
  // Another profile on this computer: the profiles folder is the home folder's parent, never a fixed name.
  assert.equal(inNeverGames('C:/Users/rydin/AppData/LocalLow/Never Games', home), true);
  assert.equal(inNeverGames('E:/Profiles/ben/AppData/LocalLow/Never Games', 'E:\\Profiles\\loth'), true);
  // Not the exception: AppData's other folders, a Never Games folder outside AppData, a way out with "..".
  assert.equal(inNeverGames('C:/Users/loth/AppData/LocalLow', home), false);
  assert.equal(inNeverGames('C:/Users/loth/AppData/LocalLow/Unity', home), false);
  assert.equal(inNeverGames('C:/Users/loth/AppData/LocalLow/Never Games/../Unity', home), false);
  assert.equal(inNeverGames('C:/Users/loth/Documents/Never Games', home), false);
  assert.equal(inNeverGames('C:/Never Games', home), false);
  assert.equal(inNeverGames('C:/Users/loth/AppData/LocalLow/Never Games Backup', home), false);
  assert.equal(inNeverGames('/Users/loth/Library/Application Support/Never Games', '/Users/loth'), false);
});

test('a scan of Never Games under AppData is allowed on Windows; the rest of C: and AppData stays refused', () => {
  fine(`du -sh "${NG}"`);
  fine('du -sh "C:/Users/loth/AppData/LocalLow/Never Games/finalfactory"/*');
  fine('du -sh ~/AppData/LocalLow/"Never Games"');
  fine('Get-ChildItem "$env:USERPROFILE\\AppData\\LocalLow\\Never Games" -Recurse -File | Measure-Object -Property Length -Sum');
  fine('gci -r "$env:LOCALAPPDATA\\Never Games"');
  fine('dir /s "%APPDATA%\\Never Games"');
  fine('find "/c/Users/loth/AppData/LocalLow/Never Games" -name "*.log"');
  fine('cd "C:/Users/loth/AppData/LocalLow/Never Games" && du -sh *');
  fine(`ff-leftovers check "${NG}\\finalfactory\\Player.log"`);
  fine(`robocopy "${NG}" V:\\ffw\\tmp\\nothing /L /S /E /BYTES`);
  refused('du -sh ~/AppData/LocalLow');
  refused('du -sh ~/AppData/LocalLow/Unity');
  refused('Get-ChildItem "$env:LOCALAPPDATA" -Recurse');
  refused('du -sh "C:/Users/loth/Documents/Never Games"');
  refused('du -sh "C:/Never Games"');
  assert.match(checkOffDriveScan('du -sh ~/AppData/LocalLow', LOTH)!, /The one exception on C: is reading the game's data folders under AppData/);
});

const SAVE_CTX: RootFenceContext = { ...LOTH, saveTag: 'ffa-1234' };
const del = (cmd: string, ctx = SAVE_CTX) => checkOutsideRootDelete(cmd, ctx);
const ngRefused = (cmd: string, ctx = SAVE_CTX) => assert.match(del(cmd, ctx) ?? '', /^Refused: .*in the game's data folder under AppData \(Never Games\)/, cmd);

test('Never Games is never modified: deletes, moves, renames, copies into it and writes are refused', () => {
  ngRefused(`rm -rf "${NG}/finalfactory/PlaytestSessions"`);
  ngRefused('rm -f ~/AppData/LocalLow/"Never Games"/finalfactory/Player-prev.log');
  ngRefused('Remove-Item -Recurse -Force "$env:USERPROFILE\\AppData\\LocalLow\\Never Games\\finalfactory\\PlaytestSessions"');
  ngRefused(`del /s /q "${NG}\\finalfactory\\Player.log"`);
  ngRefused(`find "/c/Users/loth/AppData/LocalLow/Never Games" -name "*.log" -delete`);
  ngRefused(`Get-ChildItem "${NG}" -Recurse -Filter *.log | Remove-Item`);
  ngRefused(`mv "${NG}/finalfactory/Player.log" V:/ffw/tmp/`);
  ngRefused(`Move-Item "${NG}\\finalfactory\\PlaytestSessions" V:\\ffw\\tmp\\old`);
  ngRefused(`Rename-Item "${NG}\\finalfactory\\Player.log" Player.old`);
  ngRefused(`cp V:/ffw/tmp/x.zip "${NG}/finalfactory/UserData/saves/someone.zip"`);
  ngRefused(`Copy-Item V:\\ffw\\tmp\\settings.json -Destination "${NG}\\finalfactory"`);
  ngRefused(`echo hi > "${NG}/finalfactory/x.txt"`);
  ngRefused(`Set-Content -Path "${NG}\\finalfactory\\prefs.txt" -Value 1`);
  ngRefused(`New-Item -ItemType Directory "${NG}\\finalfactory\\tmp"`);
  ngRefused(`robocopy V:\\ffw\\tmp\\saves "${NG}\\finalfactory\\UserData\\saves" /E`);
  ngRefused(`robocopy "${NG}\\finalfactory\\PlaytestSessions" V:\\ffw\\tmp\\old /MOV /E`);
  ngRefused(`powershell -Command "Remove-Item -Recurse '${NG}\\finalfactory\\PlaytestSessions'"`);
  // Local's and Roaming's too, and another profile's.
  ngRefused('Remove-Item -Recurse "$env:LOCALAPPDATA\\Never Games"');
  ngRefused('rm -rf "C:/Users/rydin/AppData/Roaming/Never Games"');
  const msg = del(`rm -rf "${NG}/finalfactory/PlaytestSessions"`)!;
  assert.match(msg, /never modified \(lothsahn, 2026-10-22, w1755: "Let's let it scan the never games folder, but not the rest of C\.  And it shouldn't modify it\."\)/);
  assert.match(msg, /python scripts\/game_data\.py/);
});

test('reading Never Games, copying out of it and your own save copy stay allowed; macOS is not judged for writes', () => {
  const saves = `${NG}/finalfactory/UserData/saves`;
  assert.equal(del(`cp "${NG}/finalfactory/Player.log" V:/ffw/tmp/`), undefined);
  assert.equal(del(`Copy-Item "${NG}\\finalfactory\\Player.log" -Destination V:\\ffw\\tmp`), undefined);
  assert.equal(del(`cat "${NG}/finalfactory/Player.log" > V:/ffw/tmp/player.log`), undefined);
  assert.equal(del(`robocopy "${NG}" V:\\ffw\\tmp\\nothing /L /S /E /BYTES`), undefined);
  // The worker's own save copy (read_rules saves): in and out again.
  assert.equal(del(`cp V:/ffw/tmp/ffa-1234/big.zip "${saves}/ffa-1234-big.zip"`), undefined);
  assert.equal(del(`rm -f "${saves}/ffa-1234-big.zip"`), undefined);
  ngRefused(`rm -f "${saves}/ffa-9999-big.zip"`);
  // The write check is Windows': a Mac's own fence is unchanged.
  assert.equal(del('mv ~/x "/Users/loth/Library/Application Support/Never Games/y"', { ...MAC, saveTag: 'ffa-1234' }), undefined);
});

test('the sandbox guard allows a Never Games scan and refuses a delete or a move there', async () => {
  const guard = sandboxGuard({ sandboxId: 'lothdesktop/slot1', sandboxPath: 'V:\\ffw\\sandboxes\\slot1', protectedPaths: [], workerRoot: 'V:\\ffw' });
  const decide = async (tool: 'Bash' | 'PowerShell', command: string) =>
    (
      (await guard({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: 'V:\\ffw\\sandboxes\\slot1' } as never, 'x', {
        signal: new AbortController().signal,
      })) as { hookSpecificOutput?: { permissionDecision?: string } }
    ).hookSpecificOutput?.permissionDecision;
  const ng = 'C:/Users/anyone/AppData/LocalLow/Never Games';
  // The guard takes the home folder from this computer (os.homedir()): use its profiles folder when it is a Windows one.
  const profiles = /^[a-zA-Z]:[\\/]/.test(os.homedir()) ? path.win32.dirname(os.homedir()).replace(/\\/g, '/') : undefined;
  if (profiles) {
    const here = `${profiles}/anyone/AppData/LocalLow/Never Games`;
    assert.notEqual(await decide('Bash', `du -sh "${here}"`), 'deny');
    assert.notEqual(await decide('PowerShell', `Get-ChildItem "${here}" -Recurse | Measure-Object -Sum Length`), 'deny');
    assert.equal(await decide('PowerShell', `Remove-Item -Recurse "${here}\\finalfactory\\PlaytestSessions"`), 'deny');
    assert.equal(await decide('Bash', `mv "${here}/finalfactory/Player.log" V:/ffw/tmp/`), 'deny');
  }
  // Whatever the home folder, a delete or a move out of a C: folder is refused, and the rest of C: is not scanned.
  assert.equal(await decide('Bash', `rm -rf "${ng}/finalfactory/PlaytestSessions"`), 'deny');
  assert.equal(await decide('Bash', 'du -sh C:/Users/anyone/AppData/LocalLow/Unity'), 'deny');
});

test("the daemon's clean-up plan on Windows reads only the install drive: no rule on C:, none in Never Games", () => {
  const env = { platform: 'win32' as const, home: 'C:\\Users\\loth', tmp: 'C:\\Users\\loth\\AppData\\Local\\Temp', localAppData: 'C:\\Users\\loth\\AppData\\Local', agentTemp: 'V:\\ffw\\tmp', sandboxRoots: ['V:\\ffw\\sandboxes'], cacheRoots: ['V:\\ffw\\sandboxes'] };
  const all = cleanupRules(env, DEFAULT_CLEANUP);
  // Before w1755 the plan read C:'s AppData caches, its temp and Never Games' PlaytestSessions.
  assert.ok(all.some((r) => /^C:/i.test(r.dir)));
  assert.ok(all.some((r) => r.id === 'playtest-sessions'));
  const kept = rulesOnInstallDrive(all, ['V:\\ffw'], env.home);
  assert.ok(kept.length > 0);
  assert.deepEqual(kept.filter((r) => !/^V:/i.test(r.dir)).map((r) => r.dir), []);
  assert.ok(kept.some((r) => r.id === 'agent-temp') && kept.some((r) => r.id === 'sandbox-lib-cache-stale'));
  // A Dev Drive's folders (another root) keep their rules; a root on C: keeps only what is inside it.
  assert.ok(rulesOnInstallDrive(cleanupRules({ ...env, agentTemp: 'W:\\tmp' }, DEFAULT_CLEANUP), ['V:\\ffw', 'W:\\'], env.home).some((r) => r.dir === 'W:\\tmp'));
  const onC = rulesOnInstallDrive(cleanupRules({ ...env, agentTemp: 'C:\\ffw\\tmp', sandboxRoots: ['C:\\ffw\\sandboxes'], cacheRoots: ['C:\\ffw\\sandboxes'] }, DEFAULT_CLEANUP), ['C:\\ffw'], env.home);
  assert.deepEqual(onC.filter((r) => !/^C:\\ffw\\/i.test(r.dir)).map((r) => r.dir), []);
  // macOS, Linux and a computer without a worker root keep every rule.
  const mac = cleanupRules({ platform: 'darwin', home: '/Users/loth', tmp: '/tmp' }, DEFAULT_CLEANUP);
  assert.equal(rulesOnInstallDrive(mac, ['/Users/Shared/ffw'], '/Users/loth').length, mac.length);
  assert.equal(rulesOnInstallDrive(all, undefined, env.home).length, all.length);
});
