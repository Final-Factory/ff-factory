- **Unity Hub's own `unity.exe serve` no longer takes a Unity slot** (w3848). On LothLaptop, `unity-slot status` said
  "editors 1 of 1: 1 interactive" with no editor open: the only Unity process was the Hub's helper,
  `"C:\Program Files\Unity Hub\resources\unity.exe" serve`, which runs as long as the Hub does, so every batch build and
  editor start there waited. `isUnityBinary` (machine/unitySlots.ts) now skips a program under the Hub's resources folder
  (`\Unity Hub\resources\` on Windows, `Unity Hub.app/Contents/Resources/` on a Mac) or one whose first argument is
  `serve`, so slot counting, the Unity reaper and leftovers all leave it alone. A Mac's Hub binary never matched. Applies at
  each daemon's next update. Tests: `unitySlots.test.ts`.
