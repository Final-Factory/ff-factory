- **No more desktop-session FUSE mounts in a worker's temp folder** (w5285, lothsahn: "Find which worker setup put a
  desktop session's runtime folder (FUSE mounts) inside an agent temp folder"). The source was a private GNOME Shell that
  worker bd1baf7b (w994) ran on biscuit on 2026-10-11 with `XDG_RUNTIME_DIR` at `<temp>/w994/gs`: its gvfsd-fuse and
  document portal mounted `gs/gvfs` and `gs/doc`, and the dead mounts blocked clean-up (w5276). The shell guard now
  refuses `XDG_RUNTIME_DIR` set to a temp folder; `ff-leftovers list` names mounts in the session's temp folder and
  `ff-leftovers end` unmounts the FUSE ones after ending the processes. Docs: self-recovery.md ("Mounts in a worker's
  temp folder"). Tests: `runtimeDirFuse.test.ts`.
