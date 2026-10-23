// w1839: a kept Live view knob is written into its .mat as text (machine/matText.ts). Ben, 2026-10-23: "Write it straight
// into the material file on the worker's branch." The fixture is the head of the game's Assets/Resources/Vfx/VfxComet.mat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keepInMat, matPathIn, setMatValue, unityFloat } from '../machine/matText.ts';

const COMET = [
  '%YAML 1.1',
  '%TAG !u! tag:unity3d.com,2011:',
  '--- !u!21 &2100000',
  'Material:',
  '  serializedVersion: 8',
  '  m_ObjectHideFlags: 0',
  '  m_Name: VfxComet',
  '  m_LockedProperties: ',
  '  m_SavedProperties:',
  '    serializedVersion: 3',
  '    m_TexEnvs: []',
  '    m_Ints: []',
  '    m_Floats:',
  '    - _BurstRadius: 4',
  '    - _FlowSpeed: 3.5',
  '    - _Intensity: 1',
  '    - _TailWaveSpeed: 1.7',
  '    m_Colors:',
  '    - _CatchAccent: {r: 3.2, g: 4.2, b: 5.0, a: 1}',
  '    - _ComaColor: {r: 0.25, g: 0.9, b: 1.1, a: 1}',
  '  m_BuildTextureStacks: []',
  '  m_AllowLocking: 1',
  '',
].join('\n');

const diff = (a: string, b: string) => {
  const x = a.split('\n');
  const y = b.split('\n');
  return y.filter((l, i) => l !== x[i] || x.length !== y.length).length;
};

test('unityFloat: the shortest text that reads back as the same 32-bit float', () => {
  assert.equal(unityFloat(1), '1');
  assert.equal(unityFloat(2.25), '2.25');
  assert.equal(unityFloat(0.35), '0.35');
  assert.equal(unityFloat(Math.fround(0.1)), '0.1');
  assert.equal(unityFloat(-0), '0');
  assert.equal(unityFloat(-1.5), '-1.5');
  assert.throws(() => unityFloat(Number.NaN));
});

test('a float already in the file changes on its own line only', () => {
  const r = setMatValue(COMET, '_Intensity', 'range', 2.25);
  assert.equal(r.was, '1');
  assert.equal(r.now, '2.25');
  assert.match(r.text, /^ {4}- _Intensity: 2\.25$/m);
  assert.equal(r.text.split('\n').length, COMET.split('\n').length);
  assert.equal(r.text.replace('- _Intensity: 2.25', '- _Intensity: 1'), COMET);
});

test('an HDR colour keeps Unity\'s {r, g, b, a} form', () => {
  const r = setMatValue(COMET, '_ComaColor', 'color', [0.5, 1.8, 2.4, 1]);
  assert.equal(r.was, '{r: 0.25, g: 0.9, b: 1.1, a: 1}');
  assert.match(r.text, /^ {4}- _ComaColor: \{r: 0\.5, g: 1\.8, b: 2\.4, a: 1\}$/m);
  assert.match(setMatValue(COMET, '_ComaColor', 'color', [1, 0, 0]).text, /_ComaColor: \{r: 1, g: 0, b: 0, a: 1\}/);
});

test('a property not in the file is added in name order; an empty section becomes a list', () => {
  const r = setMatValue(COMET, '_GlowBoost', 'float', 3);
  const floats = r.text.split('\n').filter((l) => /^ {4}- _/.test(l)).slice(0, 5).map((l) => l.trim());
  assert.deepEqual(floats, ['- _BurstRadius: 4', '- _FlowSpeed: 3.5', '- _GlowBoost: 3', '- _Intensity: 1', '- _TailWaveSpeed: 1.7']);
  const last = setMatValue(COMET, '_Zed', 'float', 1).text;
  assert.match(last, /- _TailWaveSpeed: 1\.7\n {4}- _Zed: 1\n {4}m_Colors:/);
  const ints = setMatValue(COMET, '_Steps', 'int', 4).text;
  assert.match(ints, /\n {4}m_Ints:\n {4}- _Steps: 4\n {4}m_Floats:/);
  assert.throws(() => setMatValue(COMET, '_Steps', 'int', 4.5), /whole number/);
});

test('CRLF files stay CRLF, and nothing else in the file moves', () => {
  const crlf = COMET.replace(/\n/g, '\r\n');
  const r = setMatValue(crlf, '_FlowSpeed', 'float', 4);
  assert.ok(!/[^\r]\n/.test(r.text), 'every line ends CRLF');
  assert.equal(diff(COMET, r.text.replace(/\r\n/g, '\n')), 1);
});

test('refuses what is not a material, and a path outside Assets or the sandbox', () => {
  assert.throws(() => setMatValue('Prefab:\n  m_Name: x\n', '_A', 'float', 1), /not a material/);
  assert.throws(() => setMatValue(COMET, 'bad name', 'float', 1), /not a property name/);
  const root = path.resolve('/sandbox');
  assert.equal(matPathIn(root, 'Assets/Resources/Vfx/VfxComet.mat'), path.join(root, 'Assets', 'Resources', 'Vfx', 'VfxComet.mat'));
  for (const bad of ['Assets/../ProjectSettings/x.mat', 'Packages/x.mat', 'Assets/x.shader', '/etc/x.mat', 'Assets//x.mat']) assert.throws(() => matPathIn(root, bad), bad);
});

test('keepInMat writes the file in the sandbox and says what changed', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'w1839-keep-'));
  const file = path.join(dir, 'Assets', 'Resources', 'Vfx', 'VfxComet.mat');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, COMET);
  assert.equal(keepInMat(dir, 'Assets/Resources/Vfx/VfxComet.mat', '_Intensity', 'range', 2.25), '_Intensity 1 -> 2.25');
  assert.match(fs.readFileSync(file, 'utf8'), /- _Intensity: 2\.25\n/);
  assert.equal(keepInMat(dir, 'Assets/Resources/Vfx/VfxComet.mat', '_New', 'float', 0.5), '_New (not in the file) -> 0.5');
});
