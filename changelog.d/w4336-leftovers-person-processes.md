- **`ff-leftovers` no longer takes a person's processes for a worker's** (w4336). On BEAST on 2026-11-15, a worker's
  `ff-leftovers list` and `end` counted four tab processes of Ben's own Firefox (`firefox.exe -contentproc`) as its own and
  ended them. Start time alone was never the reason. The cause was the Windows walk down from the session's processes. It
  followed the shim's MSYS parent map, which records each Git Bash program's Windows pid as Git Bash's `/proc` remembers it.
  A program that had exited left a pid that Windows had since given to a new tab, so the tab looked like the session's
  child. Start times were read only for the session's own processes, so nothing told the two apart. Now on Windows the
  command reads start times for every process. It follows a parent link only when the parent is no younger than the child,
  and an MSYS parent only when the child has no live Windows parent of its own. It never lists a process whose live
  ancestry reaches `explorer.exe` or a program started with `ff-leftovers launch` before any worker's process. The
  daemon's sweep has the same rule for a process that only names a worker's temp folder (Notepad opened on a worker's
  log). On a Mac or Linux only the environment counts, and a person's processes do not carry a worker's session; a test
  covers both. Tests: `leftovers.test.ts` (the BEAST table as a fixture: RED on the old code, which listed the four tabs and
  the Notepad). Needs a portal deploy; the daemons rewrite the shim at start.
