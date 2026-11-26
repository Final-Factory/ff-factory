import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rootEnv } from '../machine/daemon.ts';
import { editorLaunchEnv, sandboxEditorEnv } from '../machine/sandboxes.ts';
import { EDITOR_TMPDIR_MAX, batchUnityLogFile, editorTempEnv, editorTmpdirEnv, workerToolCacheEnv } from '../machine/sharedCaches.ts';

// w5297 (lothsahn: "under no circumstances should workers write outside of ffw"): every folder the daemon hands its
// children is inside the install folder, and a new place in the daemon's code that names the home folder, the user's
// AppData or the system temp is looked at before it lands. The inventory of what still writes outside, and why it cannot
// move: docs/worker-root.md 2.6.

const ROOT = path.resolve('/ffw-root');
const inside = (p: string) => path.resolve(p).startsWith(ROOT + path.sep);

test('outside writes: every folder in the daemon\'s environment is inside the root, on every OS', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const env = rootEnv(ROOT, platform);
    for (const [k, v] of Object.entries(env)) {
      if (k === 'FF_WORKER_ROOT') continue;
      if (/^\d+$/.test(v)) continue; // a switch (GH_NO_UPDATE_NOTIFIER=1), not a folder
      assert.ok(inside(v), `${platform}: ${k}=${v} is outside the root`);
    }
    for (const k of ['UV_CACHE_DIR', 'PIP_CACHE_DIR', 'npm_config_cache', 'UPM_CACHE_ROOT', 'ASSETSTORE_CACHE_PATH', 'NUGET_PACKAGES', 'DOTNET_CLI_HOME', 'PLAYWRIGHT_BROWSERS_PATH']) assert.ok(env[k], `${platform}: ${k} is set`);
    assert.equal(!!env.XDG_CACHE_HOME, platform !== 'win32', 'XDG_CACHE_HOME on macOS and Linux only');
    // A login, a licence or a person's setting must not move: gh's login and Unity's Linux licence live under these.
    for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'HOME', 'USERPROFILE']) assert.equal(env[k], undefined, `${k} is not moved`);
  }
  assert.deepEqual(Object.keys(workerToolCacheEnv(ROOT, 'linux')).filter((k) => !(k in rootEnv(ROOT, 'linux'))), []);
});

test('outside writes: a daemon-started editor on Windows keeps its temp files in the root', () => {
  assert.deepEqual(editorTempEnv({ FF_WORKER_ROOT: ROOT }, 'win32'), { TMP: path.join(ROOT, 'tmp', 'unity'), TEMP: path.join(ROOT, 'tmp', 'unity') });
  assert.deepEqual(editorTempEnv({}, 'win32'), {}, 'no root: unchanged');
  assert.deepEqual(editorTempEnv({ FF_WORKER_ROOT: ROOT }, 'darwin'), {}, 'macOS and Linux: editorTmpdirEnv');
});

test('w5833: a sandbox editor on macOS and Linux gets TMPDIR in the root only with editorTmpdir on, short enough for its sockets', () => {
  const root = path.resolve('/home/ben-ryding/ffw');
  for (const p of ['linux', 'darwin'] as const) {
    assert.deepEqual(editorTmpdirEnv(root, 'slot1', true, p), { TMPDIR: path.join(root, 'tmp', 'editor-slot1') });
    assert.deepEqual(editorTmpdirEnv(root, 'slot1', false, p), {}, 'off (the default): the system temp, as before');
    assert.deepEqual(editorTmpdirEnv(undefined, 'slot1', true, p), {}, 'no root: unchanged');
  }
  assert.deepEqual(editorTmpdirEnv(root, 'slot1', true, 'win32'), {}, 'Windows: editorTempEnv');
  // a root too deep for `<TMPDIR>/dotnet-diagnostic-<pid>-<start>-socket` under the 104-byte socket limit keeps the system temp
  const deep = path.resolve('/' + 'd'.repeat(EDITOR_TMPDIR_MAX));
  assert.deepEqual(editorTmpdirEnv(deep, 'slot1', true, 'linux'), {});
  assert.ok(path.join(root, 'tmp', 'editor-slot12').length + 'dotnet-diagnostic-4194304-4294967295-socket'.length + 2 <= 104);
  // the sandbox editor's whole env carries it, and only when asked
  assert.equal(sandboxEditorEnv({}, 'slot1', root, true, 'linux').TMPDIR, path.join(root, 'tmp', 'editor-slot1'));
  assert.equal('TMPDIR' in sandboxEditorEnv({}, 'slot1', root, false, 'linux'), false);
  assert.equal('TMPDIR' in sandboxEditorEnv({}, 'slot1', root), false, 'default off');
});

test('w5833 (review F1): the editor makes its TMPDIR at each start, and starts with the system temp when it cannot', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'w5833-f1-'));
  const lines: string[] = [];
  const t = path.join(dir, 'tmp', 'editor-slot1');
  const env = { A: '1', TMPDIR: t };
  assert.deepEqual(editorLaunchEnv(env, fs, (l) => lines.push(l)), env, 'made when missing');
  assert.ok(fs.statSync(t).isDirectory());
  fs.rmSync(t, { recursive: true });
  assert.deepEqual(editorLaunchEnv(env, fs, (l) => lines.push(l)), env, 'deleted since the last start: made again');
  assert.ok(fs.statSync(t).isDirectory());
  assert.equal(lines.length, 0);
  const fail = { mkdirSync: (() => { throw new Error('EACCES'); }) as unknown as typeof fs.mkdirSync, accessSync: fs.accessSync };
  assert.deepEqual(editorLaunchEnv(env, fail, (l) => lines.push(l)), { A: '1' }, 'cannot be made: no TMPDIR');
  const ro = { mkdirSync: fs.mkdirSync, accessSync: (() => { throw new Error('EROFS'); }) as unknown as typeof fs.accessSync };
  assert.deepEqual(editorLaunchEnv(env, ro, (l) => lines.push(l)), { A: '1' }, 'not writable: no TMPDIR');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /EACCES/);
  assert.deepEqual(editorLaunchEnv({ A: '1' }, fail, (l) => lines.push(l)), { A: '1' }, 'switch off: nothing made');
  fs.rmSync(dir, { recursive: true });
});

test('outside writes: a batch Unity run without -logFile gets one in the worker\'s temp folder', () => {
  const env = { TMPDIR: path.join(ROOT, 'tmp', 'ffa-abc'), FF_WORKER_ROOT: ROOT };
  const at = new Date('2026-11-23T10:20:30.456Z');
  const win = batchUnityLogFile(['C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.1f1\\Editor\\Unity.exe', '-batchmode', '-quit', '-projectPath', 'F:/s'], env, 'compile check', at);
  assert.equal(win, path.join(ROOT, 'tmp', 'ffa-abc', 'unity-compile-check-20261123T102030.log'));
  assert.ok(batchUnityLogFile(['/Applications/Unity/Hub/Editor/6000.3.1f1/Unity.app/Contents/MacOS/Unity', '-batchmode'], env, 'b', at));
  assert.equal(batchUnityLogFile(['Unity', '-batchmode', '-logFile', 'x.log'], env, 'b', at), undefined, 'its own -logFile stays');
  assert.equal(batchUnityLogFile(['Unity', '-batchmode', '-logfile', '-'], env, 'b', at), undefined, 'any case');
  assert.equal(batchUnityLogFile(['Unity', '-projectPath', 'p'], env, 'b', at), undefined, 'a windowed editor is left alone');
  assert.equal(batchUnityLogFile(['scripts/nightly/build_player.sh', '-batchmode'], env, 'b', at), undefined, 'a script passes its own (every game script does)');
  assert.equal(batchUnityLogFile(['Unity', '-batchmode'], {}, 'b', at), undefined, 'nowhere to put it: unchanged');
});

/**
 * Each non-test source file in machine/, server/ and shared/ that names the home folder, the user's AppData or the system
 * temp, with how many times, and why. A new file, or more uses in one, fails: say whether it writes outside the root, move
 * the write into it if it can (rootEnv, sharedCaches.ts), else add it to docs/worker-root.md 2.6 and raise the count here.
 */
const KNOWN: Record<string, [number, string]> = {
  'machine/benchQueue.ts': [1, 'exception: the bench helper\'s status file with no root given, warned in the log (w5834: <root>/tmp/bench-status otherwise)'],
  'machine/burstPref.ts': [1, 'exception: Unity\'s Burst EditorPref (registry, plist, ~/.local/share/unity3d)'],
  'machine/daemon.ts': [11, 'the no-root defaults; the macOS CI runners LaunchAgent plists get TMPDIR inside the root (w5999, the runner service own configuration, said in its PR); the Unity slots mailbox (w469); Git Bash /tmp kept from clean-up; the write lock grants Unity its ~/.config/unity3d (w5333, writes nothing itself); the gh self-test names APPDATA in its warning (w5430, reads); the owner secrets a run may not read (w5553, ownerReadDenied: reads, writes nothing; and the owner targets of the read-fence probe, w5747, reads only; the owner-secret label plan named in the read-fence probe line on LothDesktop, w5749, reads only; and on LothDesktop in on mode the owner gh folder and ~/.ssh get their No-Read-Up label, w5749, lothsahn go for C:)'],
  'machine/ownerSecrets.ts': [3, 'the owner secret paths (gh login, ~/.ssh, browsers, Keychain) the fences close to reads (w5548, w5553): names them, writes nothing there'],
  'machine/lowIntegrity.ts': [2, "reads: where the daemon user's gh keeps its login, for a Low worker's GH_CONFIG_DIR (w5430)"],
  'machine/prFlow.ts': [1, 'names APPDATA in the gh refusal (w5430, reads)'],
  'machine/evidenceGate.ts': [3, 'reads plugin and skill paths'],
  'machine/firefox.ts': [1, 'reads the Firefox profile path'],
  'machine/ghLogin.ts': [1, 'exception: gh\'s own login folder'],
  'machine/leftovers.ts': [6, 'reads; ff-leftovers launch starts a person\'s program in their home (w4047)'],
  'machine/gameData.ts': [4, 'exception: the game\'s old data folder, for a branch or build from before game PR #4237: AgentControl read, a timed run\'s save copy written and deleted after (w5306, docs 2.7); reads where a Mac\'s Steam folder is, to link it into the players\' own home (w5344)'],
  'machine/live.ts': [3, 'reads: AgentControl in the game\'s old data folder after FF_GAME_DATA_DIR\'s (w5306, docs 2.7)'],
  'machine/osJob.ts': [1, 'exception: the OS job (LaunchAgent plist, scheduled task)'],
  'machine/sharedCaches.ts': [3, 'reads: where uv is installed'],
  'machine/steamClient.ts': [1, 'reads Steam\'s install'],
  'machine/unity.ts': [7, 'reads Unity\'s default log and install paths'],
  'machine/unityMcp.ts': [2, 'reads ~/.unity-mcp and ~/.claude.json'],
  'machine/unitySlots.ts': [3, 'exception: the Unity slots mailbox ~/.ff-factory/unity-slots (w469)'],
  'server/agentAccount.ts': [2, "reads: Claude Code's folder (CLAUDE_CONFIG_DIR, else ~/.claude) named to the agents' launcher (w5598), and the VM's switch file FFF_AGENT_SWITCH names (w5651); writes nothing"],
  'server/agentTools.ts': [2, 'exception: the person\'s ~/.claude plugin marker'],
  'server/appConfig.ts': [1, 'the no-root default config folder'],
  'server/cleanup.ts': [4, 'reads: measures Unity\'s caches'],
  'server/cliTranscript.ts': [2, 'reads only: Claude Code\'s folder where CLAUDE_CONFIG_DIR is unset, and the legacy ~/.claude a pre-w5305 transcript is in'],
  'server/sessions.ts': [1, 'reads only (w5305): the legacy ~/.claude a resumed pre-switch transcript is copied from, into <root>/claude'],
  'server/daemonReads.ts': [1, 'guard: reads only'],
  'server/discordConfig.ts': [2, 'reads the ffdiscord config'],
  'server/guard.ts': [6, 'guard: path lists only'],
  'server/index.ts': [3, 'the portal\'s own defaults'],
  'server/launch.ts': [1, 'guard allow list'],
  'server/machineDeploy.ts': [2, 'the portal\'s deploy staging'],
  'server/machineSsh.ts': [2, 'reads the ssh key path'],
  'server/mainCloneGuard.ts': [2, 'guard: path lists only'],
  'server/maxEvents.ts': [1, 'the no-root default (a root puts it in <root>/daemon)'],
  'server/ownLeftovers.ts': [2, 'reads'],
  'server/pluginPaths.ts': [1, 'reads Claude Code\'s plugin folder'],
  'server/privileged.ts': [1, 'reads'],
  'server/reaper.ts': [3, 'reads'],
  'server/rootFence.ts': [5, 'guard: path lists only'],
  'server/secretGuard.ts': [3, 'guard: path lists only'],
  'server/standingGuard.ts': [1, 'guard: path lists only'],
  'server/testHistoryCi.ts': [1, 'the portal\'s own scratch'],
  'server/testMachine.ts': [2, 'the portal\'s test machine'],
  'server/machineSandboxesTestKit.ts': [1, 'the machine sandbox tests\' repos (w5826)'],
  'server/orchestratorsTestKit.ts': [1, 'the orchestrator tests\' data folder (w5826)'],
  'server/testPorts.ts': [1, 'the portal\'s test ports'],
  'server/unityHang.ts': [2, 'reads Unity\'s default log'],
  'server/unityMcp.ts': [1, 'reads ~/.unity-mcp'],
  'server/usage.ts': [1, 'reads Claude Code\'s credentials'],
};

const OUTSIDE = /homedir\(\)|env\.(HOME|USERPROFILE|LOCALAPPDATA|APPDATA|ProgramData|PROGRAMDATA)\b|tmpdir\(\)/g;

test('outside writes: no new place in the daemon names the home folder, AppData or the system temp unlooked-at', () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const found: Record<string, number> = {};
  for (const dir of ['machine', 'server', 'shared']) {
    for (const f of fs.readdirSync(path.join(repo, dir), { recursive: true }) as string[]) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const n = (fs.readFileSync(path.join(repo, dir, f), 'utf8').match(OUTSIDE) ?? []).length;
      if (n) found[`${dir}/${f.replace(/\\/g, '/')}`] = n;
    }
  }
  const news = Object.entries(found).filter(([f, n]) => n > (KNOWN[f]?.[0] ?? 0));
  assert.deepEqual(news, [], 'new uses of the home folder, AppData or the system temp: does each write outside the root? (see KNOWN above)');
});
