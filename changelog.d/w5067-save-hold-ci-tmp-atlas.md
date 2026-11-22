- **A sandbox save no longer commits a grown TMP font atlas, and no longer pushes a branch whose pull request CI runs**
  (w5067, w5068): the w656 save restores a Dynamic TextMesh Pro font asset whose only changes are its runtime glyph,
  character, glyph-rect and kerning tables and atlas pixels (server/editorNoise.ts `fontAtlasNoise`), as it does w2782's
  re-serialized materials. While a worker on the branch has an open `ci:` gate (server/savePushHold.ts `ciPushHold`), the
  save, and switchBranch's pre-switch push of unpushed commits, go to `ff-saved/<branch>-<sha>` instead of the branch:
  6d6488f046 had cancelled PR #4137's CI that way.
