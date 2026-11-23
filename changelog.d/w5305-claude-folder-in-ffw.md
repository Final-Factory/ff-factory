- **A worker machine's agents keep Claude Code's folder in the worker install, `<root>/claude`, not the person's
  `~/.claude`** (w5305, part of w5297; lothsahn: "under no circumstances should workers write outside of ffw"). The daemon
  sets `CLAUDE_CONFIG_DIR` on itself at start; the tools publish installs the plugins there, and until it has, agents start on
  the old folder as before; a conversation from before the move is copied across when it resumes; `settings.json` is
  carried once without credentials or plugin lists. The machine's own login stays where it is, and the usage probe reads it
  there. Off switch: `daemon.json` env `FF_CLAUDE_HOME: "legacy"`. docs/worker-root.md 2.7. Needs a portal deploy and the
  machines' daemon update.
