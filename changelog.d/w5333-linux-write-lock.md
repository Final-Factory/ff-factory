- **Trial: a Linux worker can be locked to writing inside the install folder** (w5333, lothsahn: "Run all three: Windows
  on LothDesktop, Linux on biscuit, Mac on m3 or m5"). Off by default. With `"writeLock": true` in a Linux machine's
  daemon.json, each agent's claude starts under `machine/ff-landlock.py`, which uses the kernel's Landlock (no root, no
  namespaces). That process and everything it starts (tools, git, gh, batch Unity, players) may write only inside the
  root, never in its `daemon` or `secrets` folders, plus a few needs measured on biscuit: the Unity slot mailbox,
  Claude Code's `cc-socks` socket folder, the Max events file, Unity's `~/.config/unity3d` and
  `~/.local/share/unity3d`, `/tmp` (Unity ignores TMPDIR for three files there), `/dev`, `/proc`, and anything listed in
  `writeLockExtra`. The agent host
  and the sandbox editor stay outside the lock. Docs: worker-root.md, "4.1 Write lock (Linux, trial)". Tests:
  `writeLock.test.ts`.
