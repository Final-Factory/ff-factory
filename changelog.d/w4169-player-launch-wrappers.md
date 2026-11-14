- **Guard: `timeout`, a subshell, `cmd //c`, a variable or inline code no longer hide a player outside a slot (w4169).**
  LothDesktop's firewall log shows the two Windows Firewall prompts of 2026-11-13 came from players a worker ran from
  `V:\ffw\tmp\ffa-b770969a\builds\<sha>-win\player\` while checkPlayerLaunch (w513) was live, so the launch took a shape
  it did not see. Its program position now sees through `timeout [-s SIG] [-k T] <n>` (the wrapper the harness tells
  workers to put around every player), `(`/`{`, Git Bash's `cmd //c`, `./finalfactory` with no extension, a `cd <dir>`
  earlier in the command, a variable set earlier in it (`P=<player>; "$P"`), and inline code (`python -c`, a heredoc
  fed to an interpreter, `powershell -Command`) that starts a player path outside a slot.
