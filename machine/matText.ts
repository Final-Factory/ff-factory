// A kept Live view knob written into its .mat as text (w1839, docs/live-view.md "Keep"). Ben, 2026-10-23: "Write it
// straight into the material file on the worker's branch." The game's look.material.keep answers the knob and the .mat
// path; this writes the value into the file's m_SavedProperties the way Unity serialises it, and touches nothing else. The
// game never saves the asset itself: a play-mode save wrote m_ObjectHideFlags: 32 into three .mat files (w1066, w1323,
// w1393; the game repo's LiveLook.cs).
import fs from 'node:fs';
import path from 'node:path';

/**
 * A material as the game names it ("VfxComet") or its Resources path ("Vfx/VfxComet"), and a shader property name ("_ComaColor"):
 * nothing else reaches the game from the Live view (server/live.ts, machine/daemon.ts).
 */
export const LIVE_MATERIAL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_ .()\/-]{0,79}$/;
export const LIVE_PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export type MatKnobType = 'float' | 'range' | 'int' | 'color' | 'vector';

/** The shortest decimal that reads back as the same 32-bit float, as Unity writes it (0.35, 1, 2.25, 1e-05). */
export function unityFloat(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`not a number: ${v}`);
  const f = Math.fround(v);
  if (Object.is(f, -0) || f === 0) return '0';
  for (let p = 1; p <= 9; p++) {
    const s = String(Number(f.toPrecision(p)));
    if (Math.fround(Number(s)) === f) return s;
  }
  return String(f);
}

const SECTION: Record<MatKnobType, 'm_Floats' | 'm_Ints' | 'm_Colors'> = { float: 'm_Floats', range: 'm_Floats', int: 'm_Ints', color: 'm_Colors', vector: 'm_Colors' };

function valueText(type: MatKnobType, value: number | number[]): string {
  if (type === 'color' || type === 'vector') {
    if (!Array.isArray(value) || value.length < 3) throw new Error(`a ${type} needs 3 or 4 numbers`);
    const [r, g, b, a = type === 'color' ? 1 : 0] = value.map(Number);
    return `{r: ${unityFloat(r)}, g: ${unityFloat(g)}, b: ${unityFloat(b)}, a: ${unityFloat(a)}}`;
  }
  const n = Number(Array.isArray(value) ? value[0] : value);
  if (type === 'int') {
    if (!Number.isInteger(n)) throw new Error(`an int needs a whole number, not ${n}`);
    return String(n);
  }
  return unityFloat(n);
}

/**
 * The .mat text with `name` set to `value` in its section (m_Floats, m_Ints or m_Colors under m_SavedProperties), added in
 * name order when missing; the line endings and everything else as they were. Throws when the text is not a material.
 */
export function setMatValue(text: string, name: string, type: MatKnobType, value: number | number[]): { text: string; was?: string; now: string } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`not a property name: ${name}`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const saved = lines.findIndex((l) => /^ {2}m_SavedProperties:\s*$/.test(l));
  if (saved < 0) throw new Error('no m_SavedProperties: not a material');
  const section = SECTION[type];
  const now = valueText(type, value);
  let head = -1;
  for (let i = saved + 1; i < lines.length && /^ {3,}|^\s*$/.test(lines[i]); i++) {
    if (new RegExp(`^ {4}${section}:`).test(lines[i])) {
      head = i;
      break;
    }
  }
  if (head < 0) throw new Error(`no ${section} under m_SavedProperties`);
  const entry = `    - ${name}: ${now}`;
  if (/:\s*\[\]\s*$/.test(lines[head])) {
    lines[head] = `    ${section}:`;
    lines.splice(head + 1, 0, entry);
    return { text: lines.join(eol), now };
  }
  // The section's entries: "    - _Name: value", until the next "    m_…:" key or a shallower line.
  let i = head + 1;
  let insertAt = -1;
  for (; i < lines.length && /^ {4}- /.test(lines[i]); i++) {
    const m = /^ {4}- ([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[1] === name) {
      const was = m[2].trim();
      lines[i] = entry;
      return { text: lines.join(eol), was, now };
    }
    if (insertAt < 0 && m[1] > name) insertAt = i;
  }
  lines.splice(insertAt < 0 ? i : insertAt, 0, entry);
  return { text: lines.join(eol), now };
}

/** The .mat a kept knob goes into: `Assets/….mat` inside the sandbox, or why not. */
export function matPathIn(sandboxPath: string, assetPath: string): string {
  const rel = assetPath.replace(/\\/g, '/');
  if (!/^Assets\/.+\.mat$/i.test(rel) || rel.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new Error(`not a .mat under Assets: ${assetPath.slice(0, 120)}`);
  const full = path.resolve(sandboxPath, rel);
  const root = path.resolve(sandboxPath) + path.sep;
  if (!full.startsWith(root)) throw new Error(`outside the sandbox: ${assetPath.slice(0, 120)}`);
  return full;
}

/** Writes a kept knob into its .mat in the sandbox; answers what it changed ("_Intensity 1.5 -> 2.25"). */
export function keepInMat(sandboxPath: string, assetPath: string, name: string, type: MatKnobType, value: number | number[]): string {
  const file = matPathIn(sandboxPath, assetPath);
  const before = fs.readFileSync(file, 'utf8');
  const r = setMatValue(before, name, type, value);
  if (r.text !== before) fs.writeFileSync(file, r.text, 'utf8');
  return `${name} ${r.was ?? '(not in the file)'} -> ${r.now}`;
}
