- **Sandbox editors on macOS and Linux can keep their temp files inside the worker root** (w5833; lothsahn, w5823: "under
  no circumstances should workers write outside of ffw", "And not just Windows, Mac and Linux too"). Behind a switch, off
  by default: `ops_worker` `machine_update` `editor_tmpdir on` (daemon.json `editorTmpdir`) starts each sandbox editor with
  TMPDIR=`<root>/tmp/editor-<sandbox>`, so `Path.GetTempPath()` in the editor and the game's tests, .NET's sockets and
  Roslyn's scratch stop landing in `/tmp`. Unity's licensing, UPM, shader-compiler and ILPP sockets stay on fixed `/tmp`
  paths whatever TMPDIR says (measured on biscuit, Unity 6000.3.19f1); the editor still licenses and resolves packages.
  `editor_tmpdir off` is the remote recovery. Docs: worker-root.md 2.4 and 2.6.
