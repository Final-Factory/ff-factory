import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linuxControlScript, linuxReloadLines, parseUnitShow, systemdUnit, unitFile, unitLabel, unitPathOf, unitWord, withUnitPath } from './machineDeployLinux.ts';
import { platformOfUname } from './machineDeploy.ts';
import { checkPlayerLaunch, checkShell } from './guard.ts';
import { linuxDrmGpu } from './system.ts';
import { machinePlatformOf, platformNoun } from '../shared/types.ts';
import { editorBinary, editorLogPath, editorTree, editorsFor, hubConfigDir, hubListedEditors } from '../machine/unity.ts';
import { gamePlayers, isUnityBinary, unityProcesses } from '../machine/unitySlots.ts';

// Linux workers (biscuit, an Ubuntu PC, 2026-10-07): the daemon as a systemd user service, Unity's Linux paths.

const UNIT = { home: '/home/u', node: '/home/u/.local/node/bin/node', flag: false, path: '/home/u/.local/node/bin:/usr/bin:/bin', appDir: '/home/u/ffw/daemon', label: 'com.fffactory.daemon' };

test('linux: the unit runs the root\'s daemon, restarted always, and a restart leaves its agents (KillMode=process)', () => {
  const u = systemdUnit(UNIT);
  assert.match(u, /^ExecStart="\/home\/u\/\.local\/node\/bin\/node" "--disable-warning=ExperimentalWarning" "\/home\/u\/ffw\/daemon\/app\/machine\/daemon\.ts" "\/home\/u\/ffw\/daemon\/daemon\.json"$/m);
  assert.match(u, /^Restart=always$/m);
  assert.match(u, /^KillMode=process$/m, 'systemd would otherwise kill the agent hosts and editors in its cgroup (w605)');
  assert.match(u, /^WantedBy=graphical-session\.target$/m, 'starts with the desktop session, which gives it a display for Unity');
  assert.match(u, /^StandardOutput=append:\/home\/u\/ffw\/daemon\/logs\/daemon\.log$/m);
  assert.match(systemdUnit({ ...UNIT, flag: true }), /node" "--experimental-strip-types" "--disable/);
  assert.equal(unitFile('/home/u/', 'com.fffactory.daemon'), '/home/u/.config/systemd/user/com.fffactory.daemon.service');
});

test('linux: unit words are quoted and keep systemd\'s % specifiers out; the PATH reads back and is replaced in place (an update keeps it, w613)', () => {
  assert.equal(unitWord('a "b" 100%\\x'), '"a \\"b\\" 100%%\\\\x"');
  assert.throws(() => unitWord('a\nb'));
  const u = systemdUnit({ ...UNIT, path: '/opt/50%/bin:/usr/bin' });
  assert.equal(unitPathOf(u), '/opt/50%/bin:/usr/bin');
  const v = withUnitPath(u, '/x/bin:/usr/bin');
  assert.equal(unitPathOf(v), '/x/bin:/usr/bin');
  assert.equal(v.replace(/^Environment="PATH=.*$/m, ''), u.replace(/^Environment="PATH=.*$/m, ''), 'nothing else changes');
  assert.equal(unitPathOf('[Service]\n'), undefined);
});

test('linux: systemctl lines; a stop or uninstall ends the agent hosts, a restart leaves them', () => {
  assert.equal(linuxReloadLines('com.fffactory.daemon'), 'systemctl --user daemon-reload\nsystemctl --user enable com.fffactory.daemon.service\nsystemctl --user restart com.fffactory.daemon.service\n');
  assert.match(linuxControlScript('start', 'com.fffactory.daemon'), /systemctl --user start com\.fffactory\.daemon\.service/);
  assert.match(linuxControlScript('restart', 'com.fffactory.daemon'), /systemctl --user restart com\.fffactory\.daemon\.service/);
  assert.doesNotMatch(linuxControlScript('restart', 'com.fffactory.daemon'), /pkill/);
  const stop = linuxControlScript('stop', 'com.fffactory.daemon', '/home/u/ffw/daemon');
  assert.match(stop, /systemctl --user stop com\.fffactory\.daemon\.service/);
  assert.match(stop, /pkill -f '\/home\/u\/ffw\/daemon\/app\/machine\/agentHost\.ts'/);
  const un = linuxControlScript('uninstall', 'com.fffactory.daemon');
  assert.match(un, /systemctl --user disable --now com\.fffactory\.daemon\.service/);
  assert.match(un, /rm -f "\$HOME\/\.config\/systemd\/user\/com\.fffactory\.daemon\.service"/);
  assert.throws(() => unitLabel('a b; rm -rf ~'));
  assert.deepEqual(parseUnitShow('Restart=always\nKillMode=process\nActiveState=active\nUnitFileState=enabled\n'), { active: true, enabled: true, restart: 'always', killMode: 'process' });
  assert.deepEqual(parseUnitShow('ActiveState=inactive\n'), { active: false, enabled: false, restart: '', killMode: '' });
});

test('linux: the platform, as uname, the daemon and sentences say it', () => {
  assert.equal(platformOfUname('Linux\n', 0), 'linux');
  assert.equal(machinePlatformOf('linux'), 'linux');
  assert.equal(machinePlatformOf('win32'), 'win32');
  assert.equal(machinePlatformOf('darwin'), 'darwin');
  assert.equal(platformNoun('linux'), 'Linux PC');
  assert.equal(platformNoun(undefined), 'Mac', 'a record from before platforms is a Mac');
});

test('linux: the guard refuses a Linux player outside a slot and an agent stopping the daemon\'s systemd service', () => {
  assert.match(checkPlayerLaunch('/home/u/ffw/sandboxes/slot1/Builds/Linux/FinalFactory.x86_64 -batchmode') ?? '', /outside a player slot/);
  assert.equal(checkPlayerLaunch('/home/u/ffw/players/slot1-0/player/FinalFactory.x86_64 -batchmode', 'slot1'), undefined);
  assert.match(checkPlayerLaunch('/home/u/ffw/players/slot2-0/player/FinalFactory.x86_64', 'slot1') ?? '', /sandbox slot2's player folder/);
  for (const cmd of [
    'systemctl --user stop com.fffactory.daemon.service',
    'systemctl --user disable --now com.fffactory.daemon',
    'systemctl --user restart com.fffactory.daemon',
    'systemctl --user mask com.fffactory.daemon.service',
    'loginctl disable-linger',
    'rm ~/.config/systemd/user/com.fffactory.daemon.service',
  ]) {
    assert.ok(checkShell(cmd), cmd);
  }
  assert.equal(checkShell('systemctl --user status com.fffactory.daemon'), undefined, 'looking is fine');
  assert.equal(checkShell('journalctl --user -u com.fffactory.daemon -n 50'), undefined);
});

test('linux: Unity Hub\'s folders, the editor binary <version>/Editor/Unity, and the editor log', () => {
  const home = '/home/u';
  assert.equal(hubConfigDir('linux', {}, home), '/home/u/.config/UnityHub');
  assert.equal(hubConfigDir('linux', { XDG_CONFIG_HOME: '/x' }, home), '/x/UnityHub');
  assert.equal(editorLogPath('linux', {}, home), '/home/u/.config/unity3d/Editor.log');
  const files: Record<string, string> = {
    '/p/ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.19f1\n',
    '/home/u/.config/UnityHub/editors-v2.json': JSON.stringify({ data: [{ version: '6000.3.19f1', location: ['/opt/unity/6000.3.19f1'] }] }),
  };
  const read = (p: string) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  };
  assert.deepEqual(hubListedEditors('linux', {}, home, read), [{ version: '6000.3.19f1', bin: '/opt/unity/6000.3.19f1/Editor/Unity' }]);
  const has = (bins: string[]) => (p: string) => bins.includes(p);
  assert.equal(editorBinary('/p', has(['/opt/unity/6000.3.19f1/Editor/Unity']), read, home, 'linux', {}), '/opt/unity/6000.3.19f1/Editor/Unity');
  assert.equal(editorBinary('/p', has(['/home/u/Unity/Hub/Editor/6000.3.19f1/Editor/Unity']), read, home, 'linux', {}), '/home/u/Unity/Hub/Editor/6000.3.19f1/Editor/Unity', "the Hub's default folder");
  assert.equal(editorBinary('/p', has(['/e/6000.3.19f1/Editor/Unity']), read, home, 'linux', {}, { editorRoot: '/e' }), '/e/6000.3.19f1/Editor/Unity');
});

const ED = '/home/u/Unity/Hub/Editor/6000.3.19f1/Editor/Unity';
const PROCS = [
  { pid: 100, ppid: 1, cmd: `${ED} -projectPath /home/u/ffw/sandboxes/slot1` },
  { pid: 101, ppid: 100, cmd: `${ED} -batchMode -name AssetImportWorker0 -projectPath /home/u/ffw/sandboxes/slot1 -parentPid 100` },
  { pid: 102, ppid: 100, cmd: '/home/u/ffw/players/slot1-0/player/FinalFactory.x86_64 -host' },
  { pid: 103, ppid: 100, cmd: '/home/u/Unity/Hub/Editor/6000.3.19f1/Editor/Data/Tools/UnityShaderCompiler' },
  { pid: 104, ppid: 1, cmd: `${ED} -batchmode -quit -projectPath /home/u/game` },
  { pid: 105, ppid: 1, cmd: '/opt/unityhub/unityhub-bin --no-sandbox' },
  { pid: 106, ppid: 1, cmd: `python run.py ${ED}` },
];

test('linux: the editors and players among the processes, and what an editor restart spares', () => {
  assert.equal(isUnityBinary(PROCS[0], 'linux'), true);
  assert.equal(isUnityBinary(PROCS[6], 'linux'), false, 'a script naming the editor is not the editor');
  assert.equal(isUnityBinary({ cmd: '/opt/x/Editor/UnityHelper' }, 'linux'), false);
  assert.deepEqual(
    unityProcesses(PROCS, 'linux').map((x) => [x.pid, x.kind, x.project]),
    [
      [100, 'interactive', '/home/u/ffw/sandboxes/slot1'],
      [104, 'batch', '/home/u/game'],
    ],
  );
  assert.deepEqual(gamePlayers(PROCS, 'linux').map((p) => p.pid), [102]);
  assert.deepEqual(editorsFor(PROCS, '/home/u/ffw/sandboxes/slot1', 'linux').map((p) => p.pid), [100]);
  const t = editorTree(PROCS, 100, '/home/u/ffw/sandboxes/slot1', 'linux');
  assert.deepEqual(t.kill.sort(), [100, 101, 103]);
  assert.deepEqual(t.spared, ['the FinalFactory player (pid 102)']);
});

test('linux: an AMD card\'s load from the amdgpu counters, the card with the most VRAM', () => {
  const files: Record<string, string> = {
    '/sys/class/drm/card0/device/mem_info_vram_total': '536870912\n',
    '/sys/class/drm/card0/device/gpu_busy_percent': '5\n',
    '/sys/class/drm/card1/device/mem_info_vram_total': '4294967296\n',
    '/sys/class/drm/card1/device/mem_info_vram_used': '1163337728\n',
    '/sys/class/drm/card1/device/gpu_busy_percent': '37\n',
  };
  const read = (p: string) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  };
  assert.deepEqual(linuxDrmGpu(read, () => ['card0', 'card1', 'card1-DP-1', 'renderD128']), { name: 'AMD GPU', memTotalMiB: 4096, memUsedMiB: 1109, utilPct: 37 });
  assert.equal(linuxDrmGpu(read, () => ['card9']), undefined, 'no amdgpu counters (an Intel card)');
  assert.equal(
    linuxDrmGpu(read, () => {
      throw new Error('no /sys');
    }),
    undefined,
  );
});
