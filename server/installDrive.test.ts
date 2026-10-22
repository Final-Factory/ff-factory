import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOffDriveScan, checkOutsideRootDelete, installDrive, onInstallDrive, type RootFenceContext } from './rootFence.ts';
import { sandboxGuard } from './guard.ts';

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
