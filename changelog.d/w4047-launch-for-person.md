- **`ff-leftovers launch` starts a program a person keeps using, and the leftover sweep never closes it** (w4047). On Ben's
  m5 (w4046) a worker opened the Epic Games Launcher with `open -a`; the app inherited the worker's `FF_SESSION_ID`, so the
  sweep ended it 2 min after the worker's turn while Ben was using it. `ff-leftovers launch <program> [args]...` (on a Mac
  `ff-leftovers launch open -a "<app>"`) starts it detached, from the home folder, without the worker's FF_* ownership
  variables or credentials and outside its temp folder, marked `FF_FOR_PERSON=<session>`. The sweep and `ff-leftovers
  list`/`end` spare a marked process (with no session) and its tree, even one run from the worker's temp folder, and the
  daemon log names it once. Ordinary leftovers are swept as before. Every worker's brief names the route. Measured on
  LothDesktop: a program started through the shim outlived the shell call, and `list` did not show it. Needs a portal deploy;
  the daemons rewrite the shim at start. Tests: `leftovers.test.ts` (fake sweep and `ownLeftovers` cases, and a real-process
  sweep on each CI OS: the launched program survives, an ordinary leftover of the same stopped session is ended).
