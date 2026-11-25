- **The portal's releases and the prepared-release record are root's** (w5505, lothsahn: "File it: root-owned release
  record, verified clean tree, read-only release folders"). `fff-update activate` runs as root at the portal's start and
  used to take `data/update.prepared.json` and release folders that the `fff` user owned. Now git runs as root, a built
  release is handed to root read-only, the record lives in root's `app/update.prepared.json`, and `activate` and
  `rollback` refuse a release whose folder, commit, tree or ownership is not as recorded (a forged record, a dirty or
  mismatched tree, a symlinked path). `/srv/fff` becomes `root:fff 1770`. The first update to this code migrates by
  itself (`fff-update init` re-clones `repo.git` as root); rolling back to a release built before it is refused. Still
  open: `node_modules` is built by `fff`. Docs: portal-on-ffbox-host.md, "The update flow".
