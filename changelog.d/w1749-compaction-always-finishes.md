- **An orchestrator's automatic compaction always finishes** (w1749, lothsahn: "Can you make sure compaction works even if I
  close the browser or the session is closed?"). A due compaction is saved on the session (`compactOwed`) until one
  finishes. A closed or stopped orchestrator is started for it; an attempt cut off by a stop, a closed session, a process
  that ended or a portal restart is retried (10 s, 30 s, 1, 2, 5 min; 6 attempts in all, each a journal line "attempt N of
  6"), and a restart runs it again at boot. While an attempt runs or a retry is owed, messages to that orchestrator wait in
  the saved send queue and go after it. Before, a deploy's stop at 05:44 on 2026-10-22 failed lothsahn's compaction 35 s
  in and nothing ran it again until a later turn. Docs: orchestrators.md ("It always finishes"). Tests:
  `autoCompact.test.ts` (due while closed, closed mid-compaction, a clean restart, and a portal that died mid-compaction).
