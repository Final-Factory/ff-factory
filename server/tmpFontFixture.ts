/**
 * A TextMesh Pro font asset as the game repo keeps `LiberationSans SDF - Fallback.asset` (trimmed: the same documents and
 * top-level fields, a few records each). `pairs` kerning records, `glyphs` glyphs and characters, `pixels` the atlas
 * texture's data; `mode` the Atlas Population Mode (1 Dynamic), `face` the face's point size.
 */
export function tmpFont(o: { pairs?: number; glyphs?: number; pixels?: string; mode?: number; face?: number } = {}): string {
  const { pairs = 1, glyphs = 0, pixels = '00000000', mode = 1, face = 90 } = o;
  const pair = (i: number) =>
    `    - m_FirstAdjustmentRecord:\n        m_GlyphIndex: ${968 + i}\n        m_GlyphValueRecord:\n          m_XPlacement: 0\n          m_YPlacement: 0\n          m_XAdvance: -0.9658203\n          m_YAdvance: 0\n      m_SecondAdjustmentRecord:\n        m_GlyphIndex: 972\n        m_GlyphValueRecord:\n          m_XPlacement: 0\n          m_YPlacement: 0\n          m_XAdvance: 0\n          m_YAdvance: 0\n      m_FeatureLookupFlags: 0\n`;
  const list = (n: number, f: (i: number) => string) => (n ? `\n${Array.from({ length: n }, (_, i) => f(i)).join('')}` : ' []\n');
  return (
    `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!114 &11400000\nMonoBehaviour:\n  m_ObjectHideFlags: 0\n  m_Name: LiberationSans SDF - Fallback\n` +
    `  m_Version: 1.1.0\n  m_FaceInfo:\n    m_FamilyName: Liberation Sans\n    m_PointSize: ${face}\n  m_AtlasPopulationMode: ${mode}\n` +
    `  m_GlyphTable:${list(glyphs, (i) => `  - m_Index: ${i + 3}\n    m_Metrics:\n      m_Width: 50\n`)}` +
    `  m_CharacterTable:${list(glyphs, (i) => `  - m_ElementType: 1\n    m_Unicode: ${i + 65}\n    m_GlyphIndex: ${i + 3}\n`)}` +
    `  m_AtlasTextures:\n  - {fileID: 28268798066460806}\n  m_AtlasWidth: 512\n  m_AtlasHeight: 512\n  m_UsedGlyphRects:${list(glyphs, (i) => `  - m_X: ${i * 60}\n    m_Y: 0\n`)}` +
    `  m_FreeGlyphRects:\n  - m_X: ${glyphs * 60}\n    m_Y: 0\n  m_ClearDynamicDataOnBuild: 1\n` +
    `  m_FontFeatureTable:\n    m_MultipleSubstitutionRecords: []\n    m_GlyphPairAdjustmentRecords:${list(pairs, pair)}` +
    `  m_FallbackFontAssetTable: []\n` +
    `--- !u!28 &28268798066460806\nTexture2D:\n  m_Name: LiberationSans SDF Atlas\n  m_Width: 512\n  m_Height: 512\n  image data: 262144\n  _typelessdata: ${pixels}\n` +
    `--- !u!21 &2140474\nMaterial:\n  m_Name: LiberationSans SDF Material\n  m_SavedProperties:\n    m_Floats:\n    - _TextureHeight: 512\n`
  );
}
