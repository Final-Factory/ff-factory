- **`ff-pr push` warns when the branch commits a dynamic TMP font atlas that only the Unity editor changed** (w5069):
  for each modified `*.asset` that is a Dynamic font whose only changes against the merge base are the runtime glyph,
  character, glyph-rect and kerning tables and the atlas pixels (server/editorNoise.ts `fontAtlasNoise`, w5067), it names
  the file and the `git checkout origin/<base> -- <file>` that drops it. It warns and does not refuse, since a person may
  change a font on purpose.
