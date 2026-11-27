- **list_machines flags a machine that is off its OS baseline** (w6603, lothsahn: "every windows box should be the same,
  etc aside from sizing"). Each daemon now sends its baseline in its hello: the versions of the tools its agents run (its own
  node, the agents' node, claude, git, bash, gh, python, uv) and its daemon.json feature keys (fences, locks, guards and the
  like; sizing, identity and folder keys left out). list_machines compares each machine with the other machines of its OS, its
  portal sandbox settings (Library seed, editors below normal, slot repos, commit check) included, and prints a
  `baseline (w6603, warn only)` line naming each key where it differs and the value the others have. Warn only: nothing is
  changed or refused. The claude probe now runs the Agent SDK's own claude (what the sessions start) when none is configured,
  so a daemon with no claude on its task's PATH no longer reports "claude ?". Docs: machines.md ("The machine baseline").
  Tests: `machine/baseline.test.ts`.
