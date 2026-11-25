- **On Windows, a Low worker can no longer touch another conversation's transcript** (w5703, item 34 of the w5451 audit;
  the Windows half of w5563). With the Low fence on and `daemon.json` `workerTranscriptLabels: true` (off by default), the
  daemon labels `<root>\claude\projects` Medium. Each agent's own `<id>.jsonl` and `<id>\` are labelled Low only while its
  claude runs. A new conversation's file is made once the CLI has answered `initialize`, since Claude Code refuses a
  pre-made one. A Low node self-test at start logs a WARNING if a plant still goes through. To go back, turn the switch off
  and restart: everything there is labelled Low again. The labels never use `icacls /T`, which follows junctions (a Low
  worker could have had the host relabel any folder Low, w5774): folders are walked and every junction or link skipped.
  Docs: transcript-seal.md ("Windows: transcript labels").
  Tests: transcriptLabels (its real-label leg on the Windows runner).
