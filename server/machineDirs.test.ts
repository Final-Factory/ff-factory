import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as win from './machineDeployWin.ts';
import { checkDirs, daemonConfig, macDirArg, plist } from './machineDeploy.ts';
import { daemonLogPath, dirOptions, machineDir, machineForPath } from './machines.ts';
import { sandboxGuard } from './guard.ts';
import { appDirOfConfig, tempEnv } from '../machine/daemon.ts';
import { editorBinary } from '../machine/unity.ts';
import { appDirOf } from '../shared/types.ts';

// A machine's own folders (docs/machines.md): add_machine's app_dir, unity_editor_root, unity_path and temp_dir.

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const decode = (b64: string) => Buffer.from(b64, 'base64');
const blobs = (script: string) => Object.fromEntries([...script.matchAll(/Write-B64 '([^']+)' '([A-Za-z0-9+/=]+)'/g)].map((m) => [m[1], decode(m[2])]));
const APP = 'D:\\work\\.ff-factory';

test('machine dirs: given folders are absolute and normalised; unset keeps the previous, "" goes back to the default', () => {
  assert.equal(machineDir('D:/work/.ff-factory/', 'app_dir'), APP);
  assert.equal(machineDir('  D:\\work\\.ff-factory\\\\ ', 'app_dir'), APP);
  assert.equal(machineDir('D:\\', 'app_dir'), 'D:\\', 'a drive root keeps its slash');
  assert.equal(machineDir('/Volumes/Work/ff/', 'app_dir'), '/Volumes/Work/ff');
  assert.equal(machineDir('', 'app_dir'), undefined);
  assert.throws(() => machineDir('~/ff', 'app_dir'), /app_dir "~\/ff" must be an absolute path/);
  assert.throws(() => machineDir('work\\ff', 'temp_dir'), /temp_dir/);

  const prev = { appDir: APP, unityEditorRoot: 'C:\\Program Files\\Unity\\Editor', tempDir: 'D:\\tmp', sandboxRoot: 'D:\\work\\ffsb' };
  assert.deepEqual(dirOptions({}, prev), { ...prev, unityPath: undefined }, 'a redeploy without options keeps them');
  assert.deepEqual(dirOptions({ appDir: '', unityPath: 'E:/U/Unity.exe', sandboxRoot: 'D:/work/ffsb2/' }, prev), { appDir: undefined, unityEditorRoot: prev.unityEditorRoot, unityPath: 'E:\\U\\Unity.exe', tempDir: 'D:\\tmp', sandboxRoot: 'D:\\work\\ffsb2' });

  assert.doesNotThrow(() => checkDirs({ appDir: APP }, 'win32', 'lothdesktop'));
  assert.throws(() => checkDirs({ appDir: APP }, 'darwin', 'm5'), /appDir "D:\\work\\.ff-factory" is not a Mac path, and m5 is a Mac/);
  assert.throws(() => checkDirs({ tempDir: '/tmp/x' }, 'win32', 'lothdesktop'), /is not a Windows path/);
});

test('machine dirs: daemon.json carries the folders, and leaves unset ones out', () => {
  const base = { portalUrl: 'https://p', id: 'lothdesktop', token: 't', repoPath: 'D:\\Games\\FF', maxSessions: 3 };
  const c = JSON.parse(daemonConfig({ ...base, appDir: APP, unityEditorRoot: 'C:\\Program Files\\Unity\\Editor', tempDir: 'D:\\tmp' }));
  assert.equal(c.appDir, APP);
  assert.equal(c.unityEditorRoot, 'C:\\Program Files\\Unity\\Editor');
  assert.equal(c.tempDir, 'D:\\tmp');
  assert.ok(!('unityPath' in c));
  assert.deepEqual(Object.keys(JSON.parse(daemonConfig(base))).sort(), ['id', 'maxSessions', 'portalUrl', 'repoPath', 'token']);
  assert.equal(appDirOfConfig({ appDir: APP }), APP);
  assert.equal(appDirOfConfig({}, '/Users/b'), path.join('/Users/b', '.ff-factory'));
  assert.deepEqual(tempEnv('D:\\tmp'), { TMP: 'D:\\tmp', TEMP: 'D:\\tmp', TMPDIR: 'D:\\tmp' });
  assert.deepEqual(tempEnv(undefined), {});
});

test('machine dirs (Windows scripts): every script works in the app_dir, and the stop also finds a daemon in the old folder', () => {
  const config = daemonConfig({ portalUrl: 'https://p', id: 'lothdesktop', token: 't', repoPath: 'D:\\Games\\FF', maxSessions: 3, appDir: APP });
  const install = win.installScript({ sid: SID, home: 'C:\\Users\\Loth', config, node: 'C:\\Program Files\\nodejs\\node.exe', flag: false, appDir: 'D:/work/.ff-factory', previousAppDir: undefined });
  for (const s of [win.uploadScript(APP), win.npmScript('C:\\n\\node.exe', 'abc', APP), install, win.controlScript('restart', APP), win.uninstallScript(APP)]) {
    assert.match(s, /^\$F = 'D:\\work\\\.ff-factory'$/m, 'the folder is the app_dir');
    assert.match(s, /^\$FFDirs = @\(@\(\$F, \(Join-Path \$env:USERPROFILE '\.ff-factory'\)\) \| Select-Object -Unique\)$/m, 'a daemon still in the default folder is stopped too');
  }
  assert.doesNotMatch(win.npmScript('C:\\n\\node.exe', 'abc', APP), /USERPROFILE '\.ff-factory\\\\app\.new'/);
  assert.match(win.npmScript('C:\\n\\node.exe', 'abc', APP), /\$app = Join-Path \$F 'app\.new'/);

  const moved = win.installScript({ sid: SID, home: 'C:\\Users\\Loth', config, node: 'C:\\n\\node.exe', flag: false, appDir: APP, previousAppDir: 'E:\\old\\ff' });
  assert.match(moved, /\$FFDirs = @\(@\(\$F, \(Join-Path \$env:USERPROFILE '\.ff-factory'\), 'E:\\old\\ff'\)/, 'moving the folder stops the daemon running from the old one');

  const task = new TextDecoder().decode(decode(/FromBase64String\('([A-Za-z0-9+/=]+)'\)\)\n\s*try \{ \$null = Register-ScheduledTask/.exec(install)?.[1] ?? ''));
  assert.match(task, /-File "D:\\work\\\.ff-factory\\run-daemon\.ps1"<\/Arguments>/);
  assert.match(task, /<WorkingDirectory>D:\\work\\\.ff-factory<\/WorkingDirectory>/);
  assert.equal(JSON.parse(blobs(install)['daemon.json'].toString('utf8')).appDir, APP);

  // Without an app_dir, nothing changes.
  assert.match(win.uploadScript(), /^\$F = \(Join-Path \$env:USERPROFILE '\.ff-factory'\)$/m);
  assert.match(win.taskXml(SID, 'C:\\Users\\Loth'), /<WorkingDirectory>C:\\Users\\Loth\\\.ff-factory<\/WorkingDirectory>/);
  assert.match(win.taskXml(SID, 'C:\\Users\\Loth', 'D:\\a&b\\ff'), /<WorkingDirectory>D:\\a&amp;b\\ff<\/WorkingDirectory>/);
});

test('machine dirs (Mac): the LaunchAgent runs the daemon from the app_dir with its daemon.json, logging there', () => {
  const p = plist('/Users/b', '/opt/homebrew/bin/node', false, '', '/Volumes/Work/ff');
  assert.match(p, /<string>\/Volumes\/Work\/ff\/app\/machine\/daemon\.ts<\/string><string>\/Volumes\/Work\/ff\/daemon\.json<\/string>/);
  assert.match(p, /<key>WorkingDirectory<\/key><string>\/Volumes\/Work\/ff\/app<\/string>/);
  assert.match(p, /<key>StandardOutPath<\/key><string>\/Volumes\/Work\/ff\/logs\/daemon\.log<\/string>/);
  assert.match(p, /<key>HOME<\/key><string>\/Users\/b<\/string>/, 'HOME stays the home');
  const d = plist('/Users/b', '/opt/homebrew/bin/node', false);
  assert.match(d, /<string>\/Users\/b\/\.ff-factory\/app\/machine\/daemon\.ts<\/string><string>\/Users\/b\/\.ff-factory\/daemon\.json<\/string>/);
  assert.equal(macDirArg("/Volumes/Bob's/ff"), `'/Volumes/Bob'\\''s/ff'`, 'quoted for the remote shell');
  assert.equal(macDirArg(undefined), '~/.ff-factory');
});

test('machine dirs: log paths, image routing and the protected folder follow the app_dir', () => {
  assert.equal(daemonLogPath('win32', APP), 'D:\\work\\.ff-factory\\logs\\daemon.log (and daemon.err.log, supervisor.log)');
  assert.equal(daemonLogPath('darwin', '/Volumes/Work/ff'), '/Volumes/Work/ff/logs/daemon.log');
  assert.equal(daemonLogPath('darwin'), '~/.ff-factory/logs/daemon.log');
  const loth = { id: 'lothdesktop', repoPath: 'E:\\Games\\FF', home: 'C:\\Users\\Loth', platform: 'win32' as const, appDir: APP };
  assert.equal(machineForPath('d:/work/.ff-factory/agents/x/shot.png', [loth])?.id, 'lothdesktop', "a standing agent's image in the app_dir");
  assert.equal(appDirOf(loth), APP);
  assert.equal(appDirOf({ home: '/Users/b' }), '/Users/b/.ff-factory');
});

test('machine dirs (guard): a worker on the machine cannot touch the app_dir in any spelling, and still works in its clone', async () => {
  const guard = sandboxGuard({ sandboxId: 'FF', sandboxPath: 'E:\\Games\\FF', protectedPaths: [appDirOf({ home: 'C:\\Users\\Loth', appDir: APP })] });
  const call = (tool_name: string, tool_input: Record<string, unknown>) =>
    guard({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: 'E:\\Games\\FF', session_id: 's', transcript_path: '', tool_use_id: 't' } as never, undefined, { signal: new AbortController().signal });
  const denied = async (tool: string, input: Record<string, unknown>) => ((await call(tool, input)) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny';
  assert.ok(await denied('Write', { file_path: 'D:\\work\\.ff-factory\\daemon.json', content: '{}' }));
  assert.ok(await denied('Edit', { file_path: 'd:/work/.ff-factory/app/machine/daemon.ts', old_string: 'a', new_string: 'b' }));
  assert.ok(await denied('Bash', { command: 'rm -rf /d/work/.ff-factory/app' }), "Git Bash's spelling");
  assert.ok(await denied('PowerShell', { command: 'Remove-Item -Recurse D:\\work\\.ff-factory\\app' }));
  assert.ok(!(await denied('Write', { file_path: 'E:\\Games\\FF\\notes.md', content: 'x' })), 'its own clone is fine');
  assert.ok(!(await denied('Write', { file_path: 'D:\\work\\other\\x.txt', content: 'x' })), 'a sibling folder is not protected');
});

test('machine dirs (Unity, Windows): unity_path wins; unity_editor_root and the Hub-chosen folder hold <version>\\Editor\\Unity.exe; Hub-listed editors count', () => {
  const REPO = 'E:\\Games\\FF';
  const env = { ProgramFiles: 'C:\\Program Files', APPDATA: 'C:\\Users\\L\\AppData\\Roaming' };
  const files: Record<string, string> = { 'E:\\Games\\FF/ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.19f1\n' };
  const read = (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p];
  };
  const LOTH = 'C:\\Program Files\\Unity\\Editor\\6000.3.19f1\\Editor\\Unity.exe';
  const hit = (want: string) => (p: string) => p === want;
  // Lothsahn's layout, given explicitly.
  assert.equal(editorBinary(REPO, hit(LOTH), read, 'C:\\Users\\L', 'win32', env, { editorRoot: 'C:\\Program Files\\Unity\\Editor' }), LOTH);
  // The same layout found by itself: the install location set in Unity Hub.
  assert.throws(() => editorBinary(REPO, hit(LOTH), read, 'C:\\Users\\L', 'win32', env), /not installed in C:\\Program Files\\Unity\\Hub\\Editor/);
  files['C:\\Users\\L\\AppData\\Roaming\\UnityHub\\secondaryInstallPath.json'] = JSON.stringify('C:\\Program Files\\Unity\\Editor');
  assert.equal(editorBinary(REPO, hit(LOTH), read, 'C:\\Users\\L', 'win32', env), LOTH);
  // An editor the Hub was pointed at, wherever it is (editors-v2.json).
  const ELSEWHERE = 'F:\\Tools\\U19\\Editor\\Unity.exe';
  files['C:\\Users\\L\\AppData\\Roaming\\UnityHub\\editors-v2.json'] = JSON.stringify({
    schema_version: 'v2',
    data: [
      { version: '6000.0.1f1', location: ['F:\\Tools\\U01\\Editor\\Unity.exe'], manual: true },
      { version: '6000.3.19f1', location: [ELSEWHERE], manual: true },
    ],
  });
  assert.equal(editorBinary(REPO, hit(ELSEWHERE), read, 'C:\\Users\\L', 'win32', env), ELSEWHERE);
  // The older editors.json, keyed by version.
  delete files['C:\\Users\\L\\AppData\\Roaming\\UnityHub\\editors-v2.json'];
  files['C:\\Users\\L\\AppData\\Roaming\\UnityHub\\editors.json'] = JSON.stringify({ '6000.3.19f1': { version: '6000.3.19f1', location: ELSEWHERE, manual: true } });
  assert.equal(editorBinary(REPO, hit(ELSEWHERE), read, 'C:\\Users\\L', 'win32', env), ELSEWHERE);
  // unity_path: used as is, and a wrong one says so.
  assert.equal(editorBinary(REPO, hit('G:\\U\\Unity.exe'), read, 'C:\\Users\\L', 'win32', env, { unityPath: 'G:\\U\\Unity.exe', editorRoot: 'C:\\x' }), 'G:\\U\\Unity.exe');
  assert.throws(() => editorBinary(REPO, () => false, read, 'C:\\Users\\L', 'win32', env, { unityPath: 'G:\\U\\Unity.exe' }), /unity_path G:\\U\\Unity\.exe does not exist/);
});

test('machine dirs (Unity, Mac): the Hub-chosen install folder and Hub-listed .app editors are found before the defaults', () => {
  const REPO = '/Users/b/game';
  const HUB = '/Users/b/Library/Application Support/UnityHub';
  const files: Record<string, string> = { '/Users/b/game/ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.19f1\n' };
  const read = (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p];
  };
  const hit = (want: string) => (p: string) => p === want;
  const EXT = '/Volumes/Fast/Unity/6000.3.19f1/Unity.app/Contents/MacOS/Unity';
  assert.equal(editorBinary(REPO, hit(EXT), read, '/Users/b', 'darwin', {}, { editorRoot: '/Volumes/Fast/Unity' }), EXT);
  assert.throws(() => editorBinary(REPO, hit(EXT), read, '/Users/b', 'darwin', {}), /Unity 6000\.3\.19f1 is not installed in \/Applications\/Unity\/Hub\/Editor/);
  files[`${HUB}/secondaryInstallPath.json`] = JSON.stringify('/Volumes/Fast/Unity');
  assert.equal(editorBinary(REPO, hit(EXT), read, '/Users/b', 'darwin', {}), EXT);
  files[`${HUB}/editors-v2.json`] = JSON.stringify({ data: [{ version: '6000.3.19f1', location: ['/Volumes/Other/U19/Unity.app'] }] });
  assert.equal(editorBinary(REPO, hit('/Volumes/Other/U19/Unity.app/Contents/MacOS/Unity'), read, '/Users/b', 'darwin', {}), '/Volumes/Other/U19/Unity.app/Contents/MacOS/Unity');
  assert.equal(editorBinary(REPO, hit('/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/MacOS/Unity'), read, '/Users/b', 'darwin', {}), '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/MacOS/Unity', 'the defaults still count');
});
