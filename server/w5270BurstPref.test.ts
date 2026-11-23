// w5270: a sandbox editor's start turns Unity's user-wide Burst EditorPref back on when another editor left it at 0.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BURST_PREF, MAC_DOMAIN, WIN_KEY, ensureBurstPrefOn, linuxPrefsOn, linuxPrefsPath, parseDefaults, parseLinuxPrefs, parseRegDword, unityPrefHash, winValueName, type BurstPlatform, type BurstPrefDeps } from '../machine/burstPref.ts';
import { MacUnity, type Proc, type UnityDeps } from '../machine/unity.ts';

// What `reg query` prints on BEAST for the value (Windows 11, reg.exe).
const REG_OFF = `\r\nHKEY_CURRENT_USER\\Software\\Unity Technologies\\Unity Editor 5.x\r\n    BurstCompilation_h2739774030    REG_DWORD    0x0\r\n\r\n`;
const REG_ON = REG_OFF.replace('0x0', '0x1');
// ~/.local/share/unity3d/prefs as Unity writes it on Linux.
const LINUX_OFF = `<unity_prefs version_major="1" version_minor="1">\n\t<pref name="BurstCompileSynchronously" type="int">0</pref>\n\t<pref name="BurstCompilation" type="int">0</pref>\n\t<pref name="kAutoRefresh" type="int">1</pref>\n</unity_prefs>\n`;

function fake(platform: BurstPlatform, answers: Record<string, { code: number; stdout: string; stderr?: string }>, files: Record<string, string> = {}) {
  const calls: string[] = [];
  const written: Record<string, string> = {};
  const d: BurstPrefDeps = {
    platform,
    home: '/home/u',
    run: async (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      const a = Object.entries(answers).find(([k]) => line.startsWith(k))?.[1] ?? { code: 1, stdout: '', stderr: 'no such command in the fake' };
      return { stderr: '', ...a };
    },
    readFile: (p) => files[p],
    writeFile: (p, s) => {
      written[p] = s;
    },
  };
  return { d, calls, written };
}

test('the Windows value name is Unity\'s djb2-xor hash (checked on a known PlayerPrefs key)', () => {
  assert.equal(unityPrefHash('UnityGraphicsQuality'), 1669003810);
  assert.equal(winValueName(), 'BurstCompilation_h2739774030');
});

test('parsers read the three stores', () => {
  assert.equal(parseRegDword(REG_OFF), 0);
  assert.equal(parseRegDword(REG_ON), 1);
  assert.equal(parseRegDword('ERROR: The system was unable to find the specified registry key or value.'), undefined);
  assert.equal(parseDefaults('0\n'), 0);
  assert.equal(parseDefaults('The domain/default pair of (com.unity3d.UnityEditor5.x, BurstCompilation) does not exist'), undefined);
  assert.equal(parseLinuxPrefs(LINUX_OFF), 0);
  assert.equal(parseLinuxPrefs('<unity_prefs/>'), undefined);
  const on = linuxPrefsOn(LINUX_OFF);
  assert.equal(parseLinuxPrefs(on), 1);
  assert.match(on, /BurstCompileSynchronously" type="int">0/, 'only BurstCompilation changes');
});

test('macOS: 0 is written back to 1 and said', async () => {
  const f = fake('darwin', { [`defaults read ${MAC_DOMAIN} ${BURST_PREF}`]: { code: 0, stdout: '0\n' }, 'defaults write': { code: 0, stdout: '' } });
  const note = await ensureBurstPrefOn(f.d);
  assert.deepEqual(f.calls, [`defaults read ${MAC_DOMAIN} ${BURST_PREF}`, `defaults write ${MAC_DOMAIN} ${BURST_PREF} -int 1`]);
  assert.match(note ?? '', /BurstCompilation was 0.*turned it back on/);
});

test('macOS: on or missing is left alone and says nothing', async () => {
  for (const r of [{ code: 0, stdout: '1\n' }, { code: 1, stdout: '', stderr: 'does not exist' }]) {
    const f = fake('darwin', { 'defaults read': r });
    assert.equal(await ensureBurstPrefOn(f.d), undefined);
    assert.equal(f.calls.length, 1, 'no write');
  }
});

test('Windows: the HKCU value at 0 is set to DWORD 1', async () => {
  const v = winValueName();
  const f = fake('win32', { 'reg query': { code: 0, stdout: REG_OFF }, 'reg add': { code: 0, stdout: 'The operation completed successfully.' } });
  const note = await ensureBurstPrefOn(f.d);
  assert.deepEqual(f.calls, [`reg query ${WIN_KEY} /v ${v}`, `reg add ${WIN_KEY} /v ${v} /t REG_DWORD /d 1 /f`]);
  assert.match(note ?? '', /Unity Editor 5\.x\\BurstCompilation_h2739774030/);
});

test('Windows: on, or the value absent, writes nothing', async () => {
  for (const r of [{ code: 0, stdout: REG_ON }, { code: 1, stdout: '', stderr: 'ERROR: unable to find' }]) {
    const f = fake('win32', { 'reg query': r });
    assert.equal(await ensureBurstPrefOn(f.d), undefined);
    assert.equal(f.calls.length, 1);
  }
});

test('Windows: a refused write is a note, not a throw', async () => {
  const f = fake('win32', { 'reg query': { code: 0, stdout: REG_OFF }, 'reg add': { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' } });
  assert.match((await ensureBurstPrefOn(f.d)) ?? '', /could not be turned on: ERROR: Access is denied/);
});

test('Linux: the prefs file at 0 is rewritten with 1; on or absent is left alone', async () => {
  const p = linuxPrefsPath('/home/u');
  const f = fake('linux', {}, { [p]: LINUX_OFF });
  assert.match((await ensureBurstPrefOn(f.d)) ?? '', /\.local\/share\/unity3d\/prefs/);
  assert.equal(parseLinuxPrefs(f.written[p]), 1);
  const g = fake('linux', {}, { [p]: linuxPrefsOn(LINUX_OFF) });
  assert.equal(await ensureBurstPrefOn(g.d), undefined);
  assert.deepEqual(g.written, {});
  const h = fake('linux', {});
  assert.equal(await ensureBurstPrefOn(h.d), undefined);
});

function unityDeps(order: string[], burst?: () => Promise<string | undefined>): UnityDeps {
  let launched = false;
  return {
    procs: async (): Promise<Proc[]> => (launched ? [{ pid: 42, ppid: 1, cmd: '/Applications/Unity/Unity.app/Contents/MacOS/Unity -projectPath /w/slot1' }] : []),
    kill: () => undefined,
    launch: () => {
      order.push('launch');
      launched = true;
      return 42;
    },
    exists: () => false,
    remove: () => undefined,
    sleep: async () => undefined,
    now: () => 0,
    burstPrefOn: burst
      ? async () => {
          order.push('burst');
          return burst();
        }
      : undefined,
  };
}

test('MacUnity.start checks the pref before it launches and says what it found', async () => {
  const order: string[] = [];
  const u = new MacUnity('/w/slot1', unityDeps(order, async () => 'Unity\'s user-wide EditorPref BurstCompilation was 0 (...); turned it back on'), () => '/U/Unity');
  const out = await u.start();
  assert.deepEqual(order, ['burst', 'launch']);
  assert.match(out, /BurstCompilation was 0.*Started \/U\/Unity/);
  assert.match(u.burstNote ?? '', /was 0/);
});

test('MacUnity.start: pref on, or a check that throws, still launches', async () => {
  const order: string[] = [];
  const u = new MacUnity('/w/slot1', unityDeps(order, async () => undefined), () => '/U/Unity');
  assert.doesNotMatch(await u.start(), /BurstCompilation/);
  assert.equal(u.burstNote, undefined);
  const order2: string[] = [];
  const v = new MacUnity('/w/slot1', unityDeps(order2, async () => {
    throw new Error('reg.exe missing');
  }), () => '/U/Unity');
  assert.match(await v.start(), /could not check Unity's Burst EditorPref: reg\.exe missing/);
  assert.deepEqual(order2, ['burst', 'launch']);
});
