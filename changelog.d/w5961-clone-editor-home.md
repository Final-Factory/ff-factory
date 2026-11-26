- **A fenced Mac worker's clone editor gets the fenced editor's home** (w5961, found in w5806 on m5). A ParrelSync clone
  editor a worker opened with `unity-slot run -- <Unity> -projectPath <sandbox>_clone_0` hung on a hidden "Moving file
  failed" modal (its layout write to `~/Library/Preferences` refused by the worker fence) and never brought up its MCP
  bridge. The daemon now gives sandbox agents on a fenced Mac `FF_UNITY_EDITOR_HOME` (`<root>/home`), and `unity-slot
  run` sets `HOME` and `CFFIXED_USER_HOME` to it for an interactive Unity editor (not `-batchmode`, not a script). Needs a
  daemon update; reaches agents started after it. Docs: machines.md. Tests: `w5961CloneEditorHome.test.ts`.
