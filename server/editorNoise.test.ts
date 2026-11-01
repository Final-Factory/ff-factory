import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noiseFiles } from './editorNoise.ts';

/** A `git diff -U0` of one modified file, its hunks given as [removed lines, added lines]. */
function diff(file: string, ...hunks: [string[], string[]][]): string {
  const body = hunks.map(([r, a], i) => [`@@ -${i * 10 + 3},${r.length} +${i * 10 + 3},${a.length} @@ Material:`, ...r.map((l) => `-${l}`), ...a.map((l) => `+${l}`)].join('\n'));
  return [`diff --git a/${file} b/${file}`, 'index 102416d28d..14e1e4cf72 100644', `--- a/${file}`, `+++ b/${file}`, ...body].join('\n') + '\n';
}

// The hunks of auto-save commits e0eefbfd47 (w2777) and a7187a019f (w2198) in the game repo, as git wrote them.
const FLIP: [string[], string[]] = [['  m_ObjectHideFlags: 0'], ['  m_ObjectHideFlags: 32']];
const LASER = diff(
  'Assets/Art/Materials/MapMaterials/LaserMapMaterial.mat',
  FLIP,
  [['  m_LightmapFlags: 3'], ['  m_LightmapFlags: 7']],
  [['    - _Color: {r: 0.72156864, g: 0.3529412, b: 0.15686275, a: 1}'], ['    - _XRMotionVectorsPass: 1', '    - _Color: {r: 0.72156864, g: 0.35294116, b: 0.1568627, a: 1}']],
);
const DYSON = diff('Assets/Art/Content/DysonBot/DysonBotMapMaterial.mat', FLIP, [['  disabledShaderPasses:', '  - MOTIONVECTORS'], ['  disabledShaderPasses: []']]);
const PINK = diff('Assets/Art/Content/SingularityLance/LancePink.mat', FLIP, [['  m_ValidKeywords:', '  - _EMISSION'], ['  m_ValidKeywords: []']]);
const FLEET = diff('Assets/Art/Materials/MapMaterials/FleetShipMapMaterial.mat', FLIP, [[], ['    - _AddPrecomputedVelocity: 0']], [['    - _Color: {r: 0.1803922, g: 0.4784314, b: 0.4078431, a: 1}'], ['    - _XRMotionVectorsPass: 1', '    - _Color: {r: 0.18039218, g: 0.47843134, b: 0.40784308, a: 1}']]);
const CORE = diff('Assets/Art/Materials/MapMaterials/PlayerMapCore.mat', [['  m_CustomRenderQueue: 3041'], ['  m_CustomRenderQueue: 2000']], [[], ['    - _XRMotionVectorsPass: 1']]);
const BEAM = diff('Assets/Resources/Vfx/VfxBeam_Mining.mat', [['    - _BeamTime: 112.963974'], ['    - _BeamTime: 25.356186']]);
const BIONIC = diff(
  'Assets/ExternalAssets/_BionicStructures/Materials/BionicStructures4.mat',
  [['  m_ValidKeywords: []'], ['  m_ValidKeywords:', '  - _EMISSION']],
  [[], ['    - unity_Lightmaps:', '        m_Texture: {fileID: 0}', '        m_Scale: {x: 1, y: 1}', '        m_Offset: {x: 0, y: 0}', '    - unity_ShadowMasks:', '        m_Texture: {fileID: 0}', '        m_Scale: {x: 1, y: 1}', '        m_Offset: {x: 0, y: 0}']],
  [[], ['    - _AlphaToMask: 0', '    - _BlendModePreserveSpecular: 1', '    - _DstBlendAlpha: 0', '    - _SrcBlendAlpha: 1']],
);

test('w2782 editor noise: the materials the editor re-serialized in play mode are noise, every kind seen in past auto-saves', () => {
  for (const d of [LASER, DYSON, PINK, FLEET, CORE, BEAM, BIONIC]) assert.equal(noiseFiles(d).length, 1, d);
  assert.deepEqual(noiseFiles(LASER + DYSON), ['Assets/Art/Materials/MapMaterials/LaserMapMaterial.mat', 'Assets/Art/Content/DysonBot/DysonBotMapMaterial.mat']);
  // Windows line ends and a path with a space (git ends its +++ line with a tab then).
  assert.equal(noiseFiles(DYSON.replace(/\n/g, '\r\n')).length, 1);
  assert.deepEqual(noiseFiles(diff('Assets/Art/Content/AtomicPrinter/AtomicPrinterEffectMaterial 1.mat', FLIP).replace('+++ b/Assets/Art/Content/AtomicPrinter/AtomicPrinterEffectMaterial 1.mat', '$&\t')), ['Assets/Art/Content/AtomicPrinter/AtomicPrinterEffectMaterial 1.mat']);
});

test('w2782 editor noise: a change a person made is kept, alone or beside the noise', () => {
  // A colour changed on purpose (more than float32 re-rounding), alone and with the HideFlags flip.
  const colour: [string[], string[]] = [['    - _Color: {r: 0.72156864, g: 0.3529412, b: 0.15686275, a: 1}'], ['    - _Color: {r: 0.8, g: 0.3529412, b: 0.15686275, a: 1}']];
  assert.deepEqual(noiseFiles(diff('A.mat', colour)), []);
  assert.deepEqual(noiseFiles(diff('A.mat', FLIP, colour)), []);
  // Noise plus a new texture, a property set to a value URP would not write, a keyword other than _EMISSION.
  assert.deepEqual(noiseFiles(diff('A.mat', FLIP, [['        m_Texture: {fileID: 0}'], ['        m_Texture: {fileID: 2800000, guid: 0123, type: 3}']])), []);
  assert.deepEqual(noiseFiles(diff('A.mat', FLIP, [[], ['    - _XRMotionVectorsPass: 0']])), []);
  assert.deepEqual(noiseFiles(diff('A.mat', FLIP, [['  m_ValidKeywords: []'], ['  m_ValidKeywords:', '  - _NORMALMAP']])), []);
  // A lightmap flag other than EmissiveIsBlack, a render queue moved anywhere but back to 2000, a shader pass disabled.
  assert.deepEqual(noiseFiles(diff('A.mat', [['  m_LightmapFlags: 3'], ['  m_LightmapFlags: 1']])), []);
  assert.deepEqual(noiseFiles(diff('A.mat', [['  m_CustomRenderQueue: 2000'], ['  m_CustomRenderQueue: 3000']])), []);
  assert.deepEqual(noiseFiles(diff('A.mat', [['  disabledShaderPasses: []'], ['  disabledShaderPasses:', '  - MOTIONVECTORS']])), []);
  // HideFlags put back to 0 (a revert of the noise) is the person's, and so is a flip to another value.
  assert.deepEqual(noiseFiles(diff('A.mat', [['  m_ObjectHideFlags: 32'], ['  m_ObjectHideFlags: 0']])), []);
  assert.deepEqual(noiseFiles(diff('A.mat', [['  m_ObjectHideFlags: 0'], ['  m_ObjectHideFlags: 52']])), []);
  // Only modified .mat files: another type, a new or a deleted material is never noise.
  assert.deepEqual(noiseFiles(diff('Assets/Mesh.asset', FLIP)), []);
  assert.deepEqual(noiseFiles(diff('A.mat', FLIP).replace('index ', 'new file mode 100644\nindex ')), []);
  assert.deepEqual(noiseFiles(diff('A.mat', FLIP).replace('index ', 'deleted file mode 100644\nindex ')), []);
  // Mode changed only (no hunk).
  assert.deepEqual(noiseFiles('diff --git a/A.mat b/A.mat\nold mode 100644\nnew mode 100755\n'), []);
});
