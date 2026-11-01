/**
 * Unity editor noise in a sandbox's materials (w2782): the changes the editor writes into a .mat by itself, which a save
 * (saveWork, w656) restores to HEAD instead of committing.
 *
 * The game's StartController.PreventRenderAssetUnloading sets HideFlags.DontUnloadUnusedAsset (32) on every render
 * material at the start of a game, which dirties the material assets; the editor then writes them out (a save of the
 * project, or on quit) with whatever URP's material validation changed in memory meanwhile. Auto-save commits e0eefbfd47
 * (w2777, lothdesktop/slot2) and aa3232bb34 (w2779, lothdesktop/slot3) committed seven such materials each on 2026-11-01,
 * which turned the game repo's "Shared shader and material users" check red on PRs #2967 and #2968. Across all 187
 * "FF Factory: saved" commits in the game repo then (346 .mat diffs, measured), every changed line of every .mat was one
 * of the kinds below, and nothing else.
 *
 * The rule is per file: a material is noise only when every changed line of its diff against HEAD is one of these kinds.
 * One line of any other kind (a colour, a texture, a keyword, a property a person set) and the whole file is saved as it
 * is, noise included. Each kind is narrow: the direction the editor writes it (0 to 32, never back), the values URP
 * writes, a float re-rounded within a few float32 steps.
 */

/** Lines the editor removes or adds by themselves, by their sign and their text (trailing spaces dropped). */
const SINGLE: { sign: '-' | '+'; re: RegExp; why: string }[] = [
  { sign: '-', re: /^ {2}m_ObjectHideFlags: 0$/, why: 'HideFlags.DontUnloadUnusedAsset set in play mode' },
  { sign: '+', re: /^ {2}m_ObjectHideFlags: 32$/, why: 'HideFlags.DontUnloadUnusedAsset set in play mode' },
  // URP's validation turns the motion-vector pass back on.
  { sign: '-', re: /^ {2}disabledShaderPasses:$/, why: 'URP motion vectors' },
  { sign: '-', re: /^ {2}- MOTIONVECTORS$/, why: 'URP motion vectors' },
  { sign: '+', re: /^ {2}disabledShaderPasses: \[\]$/, why: 'URP motion vectors' },
  // URP's validation sets _EMISSION from the emission colour, either way (LancePink, BionicStructures4).
  { sign: '-', re: /^ {2}m_ValidKeywords:( \[\])?$/, why: 'URP emission keyword' },
  { sign: '+', re: /^ {2}m_ValidKeywords:( \[\])?$/, why: 'URP emission keyword' },
  { sign: '-', re: /^ {2}- _EMISSION$/, why: 'URP emission keyword' },
  { sign: '+', re: /^ {2}- _EMISSION$/, why: 'URP emission keyword' },
];

/** Float properties URP adds with these values when it validates an older material (URP Lit's defaults). */
const URP_DEFAULTS: Record<string, string> = {
  _XRMotionVectorsPass: '1',
  _AddPrecomputedVelocity: '0',
  _AlphaToMask: '0',
  _BlendModePreserveSpecular: '1',
  _ClearCoatMask: '0',
  _ClearCoatSmoothness: '0',
  _DetailAlbedoMapScale: '1',
  _DstBlendAlpha: '0',
  _SrcBlendAlpha: '1',
};
/** Texture slots URP adds empty, each followed by these three lines. */
const URP_TEX = /^ {4}- (unity_Lightmaps|unity_LightmapsInd|unity_ShadowMasks):$/;
const URP_TEX_BODY = ['        m_Texture: {fileID: 0}', '        m_Scale: {x: 1, y: 1}', '        m_Offset: {x: 0, y: 0}'];

/** Float properties the game animates on the shared material every frame (BeamVfxPresentationSystem). */
const ANIMATED = new Set(['_BeamTime']);

const NUM = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

/** Whether `a` is `b` written again by the editor: the same text, every number the same within a few float32 steps. */
function reRounded(r: string, a: string): boolean {
  if (r.replace(NUM, 'N') !== a.replace(NUM, 'N')) return false;
  const x = r.match(NUM) ?? [];
  const y = a.match(NUM) ?? [];
  if (!x.length) return false;
  return x.every((v, i) => {
    const p = Number(v), q = Number(y[i]);
    return p === q || Math.abs(p - q) <= 1e-6 * Math.max(Math.abs(p), Math.abs(q));
  });
}

/** Whether a removed and an added line are one value the editor rewrote. */
function rewrite(r: string, a: string): boolean {
  if (reRounded(r, a)) return true;
  const lf = /^ {2}m_LightmapFlags: (\d+)$/;
  const lr = lf.exec(r), la = lf.exec(a);
  // MaterialGlobalIlluminationFlags.EmissiveIsBlack (4), which URP sets or clears from the emission colour.
  if (lr && la) return (Number(lr[1]) ^ Number(la[1])) === 4;
  // URP resets a custom render queue to the surface's own (2000, Geometry: PlayerMapCore/Glow, 3041 and 3040).
  if (/^ {2}m_CustomRenderQueue: \d+$/.test(r) && a === '  m_CustomRenderQueue: 2000') return true;
  const pr = /^ {4}- (\w+): (\S+)$/.exec(r), pa = /^ {4}- (\w+): (\S+)$/.exec(a);
  return !!(pr && pa && pr[1] === pa[1] && ANIMATED.has(pr[1]));
}

/** Whether one hunk's removed and added lines are all editor noise. */
function hunkIsNoise(removed: string[], added: string[]): boolean {
  const single = (sign: '-' | '+', l: string) => SINGLE.some((s) => s.sign === sign && s.re.test(l));
  const r = removed.filter((l) => !single('-', l));
  let a = added.filter((l) => !single('+', l));
  // Added defaults: a URP float with its default value, or an empty URP texture slot with its three lines.
  const rest: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const m = /^ {4}- (\w+): (\S+)$/.exec(a[i]);
    if (m && URP_DEFAULTS[m[1]] === m[2] && !r.some((l) => l.startsWith(`    - ${m[1]}:`))) continue;
    if (URP_TEX.test(a[i]) && URP_TEX_BODY.every((b, k) => a[i + 1 + k] === b)) {
      i += URP_TEX_BODY.length;
      continue;
    }
    rest.push(a[i]);
  }
  a = rest;
  // What is left pairs up, each removed line with an added line that rewrites it.
  if (r.length !== a.length) return false;
  for (const l of r) {
    const k = a.findIndex((x) => rewrite(l, x));
    if (k < 0) return false;
    a.splice(k, 1);
  }
  return true;
}

/**
 * The files of a `git diff -U0` whose every hunk is editor noise. Only .mat files that were modified (not added, deleted
 * or renamed) count; a file with no changed line is not noise.
 */
export function noiseFiles(diff: string): string[] {
  const out: string[] = [];
  for (const part of diff.split(/^diff --git /m).slice(1)) {
    const lines = part.split('\n').map((l) => l.replace(/\r$/, ''));
    const file = /^\+\+\+ b\/(.+?)\t?$/m.exec(part.replace(/\r/g, ''))?.[1];
    if (!file || !file.endsWith('.mat') || !/^--- a\//m.test(part) || /^(new|deleted) file mode|^rename from/m.test(part)) continue;
    const hunks: { r: string[]; a: string[] }[] = [];
    let inHunk = false;
    for (const l of lines) {
      if (l.startsWith('@@')) {
        hunks.push({ r: [], a: [] });
        inHunk = true;
      } else if (!inHunk) continue;
      else if (l.startsWith('-')) hunks[hunks.length - 1].r.push(l.slice(1).replace(/\s+$/, ''));
      else if (l.startsWith('+')) hunks[hunks.length - 1].a.push(l.slice(1).replace(/\s+$/, ''));
    }
    if (hunks.length && hunks.every((h) => h.r.length + h.a.length > 0 && hunkIsNoise(h.r, h.a))) out.push(file);
  }
  return out;
}
