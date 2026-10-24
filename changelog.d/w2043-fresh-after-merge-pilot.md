- **A fresh session after each merge, a pilot** (w2043, lothsahn: "Do a pilot for one day"). In the pilot arm
  (`worker.freshAfterMergePilotPercent`, default 0: off; drawn by request id) a worker whose pull request merged is not resumed
  with its old context: its next message starts a new session in the same sandbox and branch (the w740 new-session machinery),
  with a short hand-off of what merged and what is left; its check-in and gate resumes move there and the old session ends. Each
  worker's arm is logged. Docs: spend.md ("A fresh session after each merge"). Tests: `freshAfterMerge.test.ts`, orchestrators.
