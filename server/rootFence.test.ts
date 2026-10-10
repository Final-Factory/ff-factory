import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOutsideRootDelete, type RootFenceContext } from './rootFence.ts';
import { sandboxGuard } from './guard.ts';

/**
 * The delete fence of a worker's shell (w896, lothsahn, 2026-10-10: "Why are you clearing C: on LothDesktop? ... In general we
 * should only be clearing data in the install folder for the worker"). The cases are what w876's clean-up of LothDesktop ran
 * on C: (worker 37a50761's transcript: dotnet workload temp, the Unity Hub installer, Temp entries, LocalLow test output,
 * ~/.claude transcripts), then what a worker may still delete.
 */

const WIN: RootFenceContext = { root: 'D:\\work\\ffw', cwd: 'D:\\work\\ffw\\sandboxes\\slot5', allow: ['D:\\work\\ffw\\sandboxes\\slot5'], home: 'C:\\Users\\loth' };
const MAC: RootFenceContext = { root: '/Users/Shared/ffw', cwd: '/Users/Shared/ffw/sandboxes/slot1', home: '/Users/loth' };
const refused = (cmd: string, ctx = WIN) => checkOutsideRootDelete(cmd, ctx);
const fine = (cmd: string, ctx = WIN) => assert.equal(checkOutsideRootDelete(cmd, ctx), undefined, cmd);
const no = (cmd: string, ctx = WIN) => assert.match(checkOutsideRootDelete(cmd, ctx) ?? '', /^Refused: .* (?:is outside this machine's worker install folder|is the install folder itself)/, cmd);

test('what w876 deleted on C: is refused, in PowerShell, Git Bash and cmd spellings', () => {
  no('Remove-Item -Recurse -Force "C:\\Users\\loth\\AppData\\Local\\Temp\\*"');
  no('Remove-Item -Recurse -Force -Path C:\\Users\\loth\\AppData\\Local\\Temp\\old');
  no('Remove-Item -LiteralPath "C:\\Users\\loth\\Downloads\\UnityHubSetup.exe" -Force');
  no('rm -rf /c/Users/loth/AppData/Local/Temp/*');
  no('rm -rf "C:/Users/loth/AppData/LocalLow/Never Games/finalfactory/TestResults.xml"');
  no('rm -rf ~/.claude/projects/old-transcripts');
  no('rm -rf $HOME/.dotnet/workload-temp');
  no('Remove-Item -Recurse $env:LOCALAPPDATA\\Temp\\dotnet-workload');
  no('Remove-Item -Recurse "$env:USERPROFILE\\.claude\\projects\\x"');
  no('rd /s /q C:\\Users\\loth\\AppData\\Local\\Temp\\x');
  no('del /f /q C:\\Windows\\Temp\\*.tmp');
  no('rm -rf /c/ProgramData/PackageCache/x');
  no('Remove-Item $env:ProgramData\\PackageCache\\x -Recurse');
  no('rmdir /s /q %LOCALAPPDATA%\\Temp\\x');
  no('rm -rf D:/work/FFFRepo');
  no('rm -rf D:/work/ffw-old/x');
  no('rm -rf /d/work/ffw/../other');
  no('rm -rf D:\\work\\ffw\\..\\..\\Users');
});

test('a clean-up through a pipeline, a loop, find or xargs is read too', () => {
  no('Get-ChildItem C:\\Users\\loth\\AppData\\Local\\Temp | Remove-Item -Recurse -Force');
  no('gci C:\\Users\\loth\\AppData\\Local\\Temp -Recurse | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-3) } | ForEach-Object { Remove-Item $_.FullName -Recurse }');
  no('ls /c/Users/loth/AppData/Local/Temp | xargs rm -rf');
  no('find /c/Users/loth/AppData/Local/Temp -mtime +3 -delete');
  no('find /c/Users/loth/AppData/Local/Temp -type f -exec rm {} \\;');
  no('powershell -Command "Remove-Item -Recurse C:\\Users\\loth\\AppData\\Local\\Temp\\x"');
  no("bash -c 'rm -rf /c/Users/loth/AppData/Local/Temp/x'");
  no('cmd /c rd /s /q C:\\Users\\loth\\x');
  no('cd /c/Users/loth/AppData/Local/Temp && rm -rf old');
  no('cd C:\\Users\\loth; Remove-Item -Recurse .\\Downloads\\x');
  no('echo start && rm -rf /c/Users/loth/x 2>&1');
  no('sudo rm -rf /var/log/old', MAC);
  no('rm -rf ~/Library/Caches/Homebrew', MAC);
  no('rm -rf /Users/loth/Documents/x', MAC);
  no('rm -rf /Users/Shared/ffw', MAC); // the root itself
});

test("inside the install folder, the worker's own temp, its sandbox and a save copy are fine", () => {
  fine('rm -rf build');
  fine('rm -rf ./Library/Bee ./Temp');
  fine('rm -rf /d/work/ffw/sandboxes/slot5/Builds/old');
  fine('Remove-Item -Recurse -Force D:\\work\\ffw\\tmp\\ffa-1\\clone');
  fine('Remove-Item -Recurse "D:\\work\\ffw\\players\\slot0-1\\player"');
  fine('rm -rf D:/work/ffw/tmp/*');
  fine('rm -rf $TMP/clone');
  fine('rm -rf "$TMPDIR/shots" "${TMP}/a"');
  fine('Remove-Item -Recurse $env:TEMP\\shots');
  fine('rd /s /q %TEMP%\\x');
  fine('rm -f /tmp/note.txt');
  fine('cd D:\\work\\ffw\\tmp && rm -rf scratch');
  fine('cd .. && rm -rf slot4-copy');
  fine('rm -f "C:/Users/loth/AppData/LocalLow/Never Games/finalfactory/saves/w512-copy.zip"');
  fine('Remove-Item "$env:USERPROFILE\\AppData\\LocalLow\\Never Games\\finalfactory\\saves\\w512-copy.zip"');
  fine('rm -rf /Users/Shared/ffw/tmp/ffa-2', MAC);
  fine('rm -rf "/Users/loth/Library/Application Support/Never Games/finalfactory/saves/w512-copy.zip"', MAC);
  // Not judged: what the text does not say.
  fine('rm $F');
  fine('rm -rf $(ls -d /c/Users/loth/x*)');
  // Measuring, listing and everything that is not a removal.
  fine('Get-ChildItem D:\\work\\ffw\\tmp | Remove-Item -Recurse');
  fine('ls /c/Users/loth/AppData/Local/Temp | wc -l');
  fine('du -sh /c/Users/loth/AppData/Local/Temp');
  fine('Get-ChildItem C:\\Users\\loth\\AppData\\Local\\Temp -Recurse | Measure-Object -Property Length -Sum');
  fine('echo "rm -rf /c/Users/x"');
  fine('git clean -fdx');
  fine('Remove-Item -Recurse build -ErrorAction SilentlyContinue');
  fine('rm --help');
});

test('the saves allowance covers one entry, never the whole folder or a wildcard of it', () => {
  no('rm -rf "C:/Users/loth/AppData/LocalLow/Never Games/finalfactory/saves"');
  no('rm -f "C:/Users/loth/AppData/LocalLow/Never Games/finalfactory/saves/*"');
  no('rm -rf "C:/Users/loth/AppData/LocalLow/Never Games/finalfactory"');
});

test('the message says the rule, what to do instead and who said it', () => {
  const msg = refused('rm -rf /c/Users/loth/AppData/Local/Temp/x')!;
  assert.match(msg, /outside this machine's worker install folder \(D:\\work\\ffw\)/);
  assert.match(msg, /lothsahn, 2026-10-10, w896: "in general we should only be clearing data in the install folder for the worker"/);
  assert.match(msg, /measure and report sizes/);
  assert.match(msg, /list any setting or script that makes FF Factory write there so it can be moved inside the folder/);
  assert.match(msg, /docs\/self-recovery\.md, "Where clean-up may delete"/);
});

test('the sandbox guard applies it when the spec carries a worker root, and not otherwise', async () => {
  const run = async (g: ReturnType<typeof sandboxGuard>, command: string) => {
    const r = (await g({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: 'D:\\work\\ffw\\sandboxes\\slot5' } as never, 'x', { signal: new AbortController().signal })) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    return r.hookSpecificOutput;
  };
  const withRoot = sandboxGuard({ sandboxId: 'slot5', sandboxPath: 'D:/work/ffw/sandboxes/slot5', protectedPaths: ['D:/work/FFFRepo'], workerRoot: 'D:\\work\\ffw' });
  const without = sandboxGuard({ sandboxId: 'slot5', sandboxPath: 'D:/work/ffw/sandboxes/slot5', protectedPaths: ['D:/work/FFFRepo'] });
  const cmd = 'Remove-Item -Recurse -Force C:\\Users\\loth\\AppData\\Local\\Temp\\old';
  const denied = await run(withRoot, cmd);
  assert.equal(denied?.permissionDecision, 'deny');
  assert.match(denied?.permissionDecisionReason ?? '', /outside this machine's worker install folder/);
  assert.equal((await run(without, cmd))?.permissionDecision, undefined);
  assert.equal((await run(withRoot, 'rm -rf Builds/old'))?.permissionDecision, undefined);
  assert.equal((await run(withRoot, 'rm -rf /d/work/ffw/tmp/ffa-1/clone'))?.permissionDecision, undefined);
});
