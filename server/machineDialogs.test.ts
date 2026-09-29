import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { MacUnity, MacUnityWatch, type Proc, type UnityDeps } from '../machine/unity.ts';
import { closeWindow, decideClose, findClosable, findDialogs, listWindows, type Dialog, type EditorWindow } from './watchdog.ts';

/**
 * The machines' Unity dialog watch on Windows (docs/unity-dialogs.md, "Macs"): the host's rule table and safe answers,
 * the FMOD Setup Wizard closed without touching it, and every automatic answer in the daemon log.
 */

const REPO = 'D:\\work\\ffsb\\sb1';
const BIN = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.19f1\\Editor\\Unity.exe';
const MAIN: EditorWindow = { hwnd: 1, pid: 100, class: 'UnityContainerWndClass', title: 'sb1 - Main - Windows, Mac, Linux - Unity 6000.3.19f1 <DX12>', enabled: false, owned: false, text: [], buttons: [] };
const WIZARD: EditorWindow = { hwnd: 2, pid: 100, class: 'UnityContainerWndClass', title: 'FMOD Setup Wizard', enabled: true, owned: false, text: [], buttons: [] };
const dialog = (hwnd: number, title: string, text: string[], buttons: string[]): EditorWindow => ({ hwnd, pid: 100, class: '#32770', title, enabled: true, owned: true, text, buttons });

test('closable windows: only the whole title "FMOD Setup Wizard", never the main window or a dialog about FMOD', () => {
  const found = findClosable([MAIN, WIZARD, { ...WIZARD, hwnd: 3, title: 'FMOD Setup Wizard - Unity 6000.3' }, dialog(4, 'Repair FMOD Libraries', ['line endings'], ['Repair', 'Ignore'])]);
  assert.deepEqual(found.map((d) => [d.hwnd, d.closable.id]), [[2, 'fmod-setup-wizard']]);
  assert.deepEqual(findDialogs([MAIN, WIZARD]), [], 'a window with no buttons is no dialog: it is only closed, never pressed');
  // Closed each time it comes back, unless that is a loop.
  const at = (ms: number) => new Date(Date.parse('2026-09-29T10:00:00Z') + ms).toISOString();
  const now = Date.parse('2026-09-29T10:00:00Z') + 60_000;
  assert.deepEqual(decideClose(WIZARD, [{ at: at(0), title: 'FMOD Setup Wizard' }], now), { close: true });
  assert.match((decideClose(WIZARD, [{ at: at(50_000), title: 'FMOD Setup Wizard' }], now) as { why: string }).why, /within 20 s/);
});

/** A Windows PC with one editor of a sandbox, scripted windows, and the daemon log. */
function pcWithWindows() {
  const world = { now: Date.parse('2026-09-29T10:00:00Z'), wins: [MAIN, WIZARD] as EditorWindow[], acted: [] as string[], log: [] as string[] };
  const procs: Proc[] = [{ pid: 100, ppid: 1, cmd: `"${BIN}" -projectPath "${REPO}" -logFile "${REPO}\\Logs\\sandbox-editor.log"` }];
  const deps: UnityDeps = {
    procs: async () => [...procs],
    kill: () => undefined,
    launch: () => 1,
    exists: () => false,
    remove: () => undefined,
    sleep: async (ms) => void (world.now += ms),
    now: () => world.now,
  };
  const reports: string[] = [];
  const u = new MacUnity(REPO, deps, () => BIN, 'win32');
  const gone = (hwnd: number) => (world.wins = world.wins.filter((w) => w.hwnd !== hwnd));
  const w = new MacUnityWatch(u, (t) => reports.push(t), {
    logStat: () => ({ size: 1, mtimeMs: world.now }),
    logTail: () => '',
    bridge: () => ({}),
    ping: async () => false,
    now: () => world.now,
    // What listWinDialogs makes of scripts/unity-windows.ps1's report.
    listDialogs: async () => ({ dialogs: findDialogs(world.wins), closable: findClosable(world.wins), mainTitle: MAIN.title, windows: world.wins.length }),
    pressButton: async (_pid, d: Dialog, button) => {
      world.acted.push(`${d.title} -> ${button}`);
      gone(d.hwnd);
      return true;
    },
    closeWindow: async (_pid, d: Dialog) => {
      world.acted.push(`close ${d.title}`);
      gone(d.hwnd);
      return true;
    },
    sceneFilesClean: async () => true,
    nodePath: () => 'C:\\Program Files\\nodejs\\node.exe',
    sessionState: async () => ({}),
    axTrusted: async () => undefined,
    log: (line) => world.log.push(line),
  });
  return { world, w, reports };
}

test('machine dialog watch on Windows: the FMOD wizard closed, the startup dialogs answered safely, each logged', async () => {
  const { world, w, reports } = pcWithWindows();
  world.wins.push(dialog(10, 'Repair FMOD Libraries', ['The following FMOD libraries contain incorrect line endings, and need to be repaired:'], ['Repair', 'Ignore']));
  assert.equal(await w.tick(), 'ok');
  assert.deepEqual(world.acted, ['close FMOD Setup Wizard', 'Repair FMOD Libraries -> Ignore']);
  assert.deepEqual(world.log, ['unity sb1: closed "FMOD Setup Wizard"', 'unity sb1: dismissed "Repair FMOD Libraries" with "Ignore"']);
  assert.deepEqual(reports, [], 'safe answers are not news');

  world.now += 60_000;
  world.wins.push(dialog(11, 'Connection Lost', ['The connection with the Unity Licensing Client has been lost.'], ['Retry']));
  world.wins.push(dialog(12, 'Font Coverage', ['No coverage errors. See the Console for the full report.'], ['OK']));
  await w.tick();
  assert.deepEqual(world.acted.slice(2), ['Connection Lost -> Retry', 'Font Coverage -> OK']);
  assert.equal(world.log.at(-1), 'unity sb1: dismissed "Font Coverage" with "OK"');
  assert.match(w.describe(), /auto-answered in the last hour: .*"FMOD Setup Wizard" -> Close/);

  // Font Coverage with errors waits for a person; so does anything that is not a safe answer.
  world.wins.push(dialog(13, 'Font Coverage', ['3 coverage error(s). See the Console and Localization/FontCoverageReport.txt.'], ['OK']));
  await w.tick();
  assert.equal(world.acted.length, 4);
  assert.equal(reports.filter((r) => /Font Coverage/.test(r)).length, 1);

  // The wizard back 10 s after being closed is a loop: left open and reported once.
  world.wins = [MAIN, { ...WIZARD, hwnd: 20 }];
  await w.tick();
  const closes = () => world.acted.filter((a) => a.startsWith('close')).length;
  world.now += 10_000;
  world.wins = [MAIN, { ...WIZARD, hwnd: 21 }];
  await w.tick();
  await w.tick();
  assert.equal(closes(), 2);
  assert.equal(reports.filter((r) => /"FMOD Setup Wizard" and it was left open: it came back within 20 s/.test(r)).length, 1);
  assert.match(w.describe(), /blocked on a dialog: FMOD Setup Wizard/);
});

test('unity-windows.ps1 on Windows: lists a real window, closes it only while it has the title it was asked for', { skip: process.platform !== 'win32' && 'Windows only' }, async (t) => {
  // A process with two windows standing in for the editor: "FMOD Setup Wizard" and one that must never be closed.
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$a = New-Object System.Windows.Forms.Form; $a.Text = 'FMOD Setup Wizard'; $a.ShowInTaskbar = $false; $a.Show()
$b = New-Object System.Windows.Forms.Form; $b.Text = 'sb1 - Main - Unity 6000.3'; $b.ShowInTaskbar = $false; $b.Show()
[Console]::Out.WriteLine('up'); [Console]::Out.Flush()
while ($b.Visible) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }`;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => p.kill());
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('the test windows did not come up')), 30_000);
    p.stdout.on('data', (d: Buffer) => d.toString().includes('up') && (clearTimeout(timer), res()));
  });
  const wins = await listWindows([p.pid!]);
  const [wizard] = findClosable(wins);
  assert.ok(wizard, `the wizard window is found among ${JSON.stringify(wins.map((w) => w.title))}`);
  const other = wins.find((w) => w.title.startsWith('sb1 - Main'))!;
  await assert.rejects(closeWindow(p.pid!, other.hwnd, 'FMOD Setup Wizard'), /is not titled 'FMOD Setup Wizard'/);
  assert.equal(await closeWindow(p.pid!, wizard.hwnd, 'FMOD Setup Wizard'), true);
  const after = await listWindows([p.pid!]);
  assert.deepEqual(after.map((w) => w.title), ['sb1 - Main - Unity 6000.3'], 'only the wizard closed');
});
