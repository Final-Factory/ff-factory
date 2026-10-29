- **The shell guard judges the command that runs and the repository it commits in** (w2503, two misfires a worker on w2474
  hit and worked around). A kill, taskkill or shutdown word inside a quoted PR title, body or commit message
  (`--title`, `--body`, `-m`, `-t`, `-b`, `--message`, `--subject`, `--notes`, a PowerShell `@'...'@`) or a quoted heredoc fed
  to git, gh, ff-pr, cat or tee is text, not a command: `ff-pr push --title "... OOM kill ..."` is no longer refused. Text the
  shell runs (`"$(pkill -f node)"`, backticks, `bash -c`, `powershell -Command`, a heredoc fed to a shell) is judged as
  before, and `"$(pkill ...)"` is now caught where it was missed. The urgent-branch commit guard (w1856) follows `cd` and
  `git -C` through the worker's variables ($TMPDIR, $HOME, ~) and reads the branch of the repository the commit runs in, so a
  commit in the worker's own clone is judged by that clone's branch, not the sandbox's; a folder it cannot follow still counts
  as the sandbox, and the refusal now says so and how to name it. Tests: `guard.test.ts`, `releaseHandBack.test.ts`.
