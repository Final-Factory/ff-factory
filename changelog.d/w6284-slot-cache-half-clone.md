- **A sandbox's half-made cache clone is completed** (w6284, follow-up of w5615). When some of a sandbox's tool-cache
  clones failed (on LothDesktop the daemon's first pass ran before its Low node copies, so slot1 got pip, nuget and
  ms-playwright but not uv, npm, upm or dotnet), its marker still counted the folder as a whole clone and nothing tried
  again. Now each sandbox's clone is checked cache by cache: the missing ones are cloned at a later 10-minute pass (after an
  hour when one failed, or as soon as the Windows daemon has its Low node copies), and the log says which it made and which
  were already there. The shared-lock start line's `With "on" it would stay off` list names each sandbox's missing caches.
  Warn only: nothing is refused. Applies at the daemon's next update. Docs: worker-root.md.
