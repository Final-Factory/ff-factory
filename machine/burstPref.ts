// w5270: keep Unity's user-wide Burst EditorPref on before every sandbox editor starts.
//
// Burst keeps "Jobs > Burst > Enable Compilation" in a user-wide EditorPref, `BurstCompilation`
// (com.unity.burst Runtime/Editor/BurstEditorOptions.cs: read with EditorPrefs.GetBool("BurstCompilation", true) when the
// options first load, and ALL five Burst prefs written back from the live options whenever any option changes). Every
// editor of that user on the machine reads it, whatever project. One editor that sets
// `BurstCompiler.Options.EnableBurstCompilation = false` (the game's LocalMultiplayerAutomationLauncher did, before w5270),
// or one forced off for its own process (--burst-disable-compilation, UNITY_BURST_DISABLE_COMPILATION) that then changes
// any Burst option, saves False there, and every editor started after it runs its jobs managed, 4-8x slower (BEAST,
// found by w5250 on 2026-11-23). lothsahn's rule: test runs keep Burst on, a stall is waited out, never disabled.
//
// Where the pref lives (Unity's own stores; a bool is an int 0/1):
//   macOS:   the defaults domain com.unity3d.UnityEditor5.x, key BurstCompilation (integer).
//   Windows: HKCU\Software\Unity Technologies\Unity Editor 5.x, value BurstCompilation_h<djb2-xor hash> (REG_DWORD).
//   Linux:   ~/.local/share/unity3d/prefs, <pref name="BurstCompilation" type="int">0</pref>.
// Missing means on (Burst's default). Only an explicit 0 is turned back to 1. Best effort: a failure is a note, never a
// refused start.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../server/proc.ts';

export type BurstPlatform = 'darwin' | 'win32' | 'linux';

export const BURST_PREF = 'BurstCompilation';
export const MAC_DOMAIN = 'com.unity3d.UnityEditor5.x';
export const WIN_KEY = 'HKCU\\Software\\Unity Technologies\\Unity Editor 5.x';

/** Unity's registry suffix for a pref name: `_h` + the djb2-xor hash (UnityGraphicsQuality_h1669003810). */
export function unityPrefHash(name: string): number {
  let h = 5381;
  for (const c of name) h = (Math.imul(h, 33) ^ c.charCodeAt(0)) >>> 0;
  return h;
}

export const winValueName = (name = BURST_PREF) => `${name}_h${unityPrefHash(name)}`;

/** `reg query` output -> the DWORD, or undefined when the value is absent or unreadable. */
export function parseRegDword(out: string, value = winValueName()): number | undefined {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/i.exec(line);
    if (m && m[1].toLowerCase() === value.toLowerCase()) return parseInt(m[2], 16);
  }
  return undefined;
}

/** `defaults read <domain> BurstCompilation` output -> the number, or undefined. */
export function parseDefaults(out: string): number | undefined {
  const s = out.trim();
  return /^-?\d+$/.test(s) ? Number(s) : undefined;
}

const LINUX_RE = /<pref\s+name="BurstCompilation"\s+type="int">\s*(-?\d+)\s*<\/pref>/;

/** The Linux prefs XML -> the value, or undefined when it has no BurstCompilation pref. */
export function parseLinuxPrefs(xml: string): number | undefined {
  const m = LINUX_RE.exec(xml);
  return m ? Number(m[1]) : undefined;
}

/** The Linux prefs XML with BurstCompilation set to 1 (only an existing entry is changed). */
export function linuxPrefsOn(xml: string): string {
  return xml.replace(LINUX_RE, '<pref name="BurstCompilation" type="int">1</pref>');
}

export interface BurstPrefDeps {
  platform: BurstPlatform;
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  readFile(p: string): string | undefined;
  writeFile(p: string, s: string): void;
  home: string;
}

export const linuxPrefsPath = (home: string) => path.posix.join(home, '.local', 'share', 'unity3d', 'prefs');

/**
 * Read the pref and turn an explicit off back on. Answers a note to log and show (undefined when it was on or absent),
 * never throws.
 */
export async function ensureBurstPrefOn(d: BurstPrefDeps): Promise<string | undefined> {
  const found = (where: string) =>
    `Unity's user-wide EditorPref ${BURST_PREF} was 0 (Burst compilation off for every editor of this user, ${where}); ` +
    'turned it back on before the start (w5270: test runs keep Burst on; a run that needs it off uses --burst-disable-compilation for its own process)';
  try {
    if (d.platform === 'darwin') {
      const r = await d.run('defaults', ['read', MAC_DOMAIN, BURST_PREF]);
      if (r.code !== 0 || parseDefaults(r.stdout) !== 0) return undefined;
      const w = await d.run('defaults', ['write', MAC_DOMAIN, BURST_PREF, '-int', '1']);
      return w.code === 0 ? found(`defaults ${MAC_DOMAIN}`) : `Unity's EditorPref ${BURST_PREF} is 0 and could not be turned on: ${w.stderr.trim().slice(0, 200)}`;
    }
    if (d.platform === 'win32') {
      const v = winValueName();
      const r = await d.run('reg', ['query', WIN_KEY, '/v', v]);
      if (r.code !== 0 || parseRegDword(r.stdout, v) !== 0) return undefined;
      const w = await d.run('reg', ['add', WIN_KEY, '/v', v, '/t', 'REG_DWORD', '/d', '1', '/f']);
      return w.code === 0 ? found(`${WIN_KEY}\\${v}`) : `Unity's EditorPref ${BURST_PREF} is 0 and could not be turned on: ${(w.stderr || w.stdout).trim().slice(0, 200)}`;
    }
    const p = linuxPrefsPath(d.home);
    const xml = d.readFile(p);
    if (xml === undefined || parseLinuxPrefs(xml) !== 0) return undefined;
    d.writeFile(p, linuxPrefsOn(xml));
    return found(p);
  } catch (e) {
    return `could not check Unity's EditorPref ${BURST_PREF}: ${(e as Error).message}`;
  }
}

export function realBurstPrefDeps(platform: BurstPlatform): BurstPrefDeps {
  return {
    platform,
    run: (cmd, args) => run(cmd, args, { timeoutMs: 15_000 }),
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    writeFile: (p, s) => fs.writeFileSync(p, s),
    home: os.homedir(),
  };
}
