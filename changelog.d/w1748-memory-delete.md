- **Orchestrators can delete a memory file** (w1748, lothsahn: "Please make it so you can delete memory files"). The new
  `delete_memory` tool (group `core`, deferred; every person's orchestrator and the dispatcher) deletes one `.md` file
  directly in the caller's own memory folder, never `MEMORY.md`, no folders, wildcards or paths out of the folder, and only
  in a turn its person started with a message of their own (the gate of its Write and Edit). Each delete is logged in the
  journal (who, which file, when), and the file is first copied to `<memory root>.backup/trash/<folder>/`, kept 30 days
  (each backup pass prunes older copies) and readable by its own orchestrator so it can write it back. The brief and
  docs/orchestrators.md ("Deleting a memory") say to delete a wrong memory and then remove its line from `MEMORY.md`.
