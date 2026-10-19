- **A worker may delete its own save copy when the path has a space** (w1505, ben: "the clean-up hook rejects rm of a
  worker's own save copy when the path has a space"). The delete fence (`server/rootFence.ts`) split a command's words at
  every space, so `rm -f ~/.config/unity3d/"Never Games"/.../ffa-<session>-x.zip` and the `Never\ Games` form were judged as
  `.../"Never` and refused, and its saves pattern did not know Linux's or macOS's folder at all. Words are now read as the
  shell reads them (a quoted part and an escaped space stay in their word; in a Windows path a backslash stays a separator),
  and the saves allowance is narrowed to one entry named after the session's own temp folder (`ffa-<session>-<name>`, from
  the shell's TMPDIR) in the game's saves folder on Windows, Linux or macOS: another session's copy, a person's save, a
  wildcard and a path with `..` are refused. The session's own answer to Claude Code's delete prompt (`server/tempDelete.ts`)
  knows the Linux and macOS saves folders and the escaped space too. Needs a portal deploy and the machine daemon update that
  follows it. Docs: self-recovery.md. Tests: `rootFence.test.ts`, `tempDelete.test.ts`.
