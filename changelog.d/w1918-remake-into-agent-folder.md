- **A reset drive's sandbox is remade even with an agent in it** (w1918). Starting an agent makes its sandbox folder, so
  after LothLaptop's V: came back empty its slot1 had a folder but no checkout, and the pool never remade it. A sandbox folder
  with no `.git` now counts as gone: the worktree is added beside it and moved in, keeping the agent's files; a folder with a
  checkout's files but no `.git` is left as an error. Test: `machineSandboxes.test.ts`.
