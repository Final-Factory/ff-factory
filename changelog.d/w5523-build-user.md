- **The portal VM builds releases as an account of its own, not fff** (w5523, lothsahn: "build node_modules as a
  dedicated build user, not fff"). `fff-update` makes the system account `fffbuild` (no login, not in fff's group, home
  `/var/lib/fff-build`, `--x` on `/srv/fff` by an ACL) and runs `npm ci` and the web build as it, with a clean
  environment, in a release folder fff cannot write; its leftover processes are ended before root takes the release
  over (w5505). So fff can no longer plant code in the `node_modules` root runs from `current/`. If the account cannot
  be made, the release is built as fff as before, and the journal and the dispatcher get a `SECURITY` warning; a
  failed build keeps the running release. `install.sh` adds the `acl` package; the deploy after this one is the first
  built as `fffbuild`. Docs: portal-on-ffbox-host.md ("The update flow"). Tests: `fff-update.test.sh`, `ci-vm-e2e.sh`.
