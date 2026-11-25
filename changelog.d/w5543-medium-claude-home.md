- **Standing agents and other Medium agents on a machine use their own Claude folder, `<root>/claude-medium`, which workers
  cannot write** (w5543; lothsahn: "File it: separate Claude settings folder for Medium agents"). Before, they loaded
  settings, hooks and plugins from `<root>/claude`, which every fenced worker can write, so a worker could plant a hook a
  Medium agent ran. The folder stays Medium on Windows and read-only under the Linux and macOS fences; the tools publish
  installs the plugins into both folders in one run, and settings are carried from `~/.claude`. Needs a portal deploy
  (machines' daemons update after it). docs/worker-root.md 2.8.
