- **A hand-made second instance's daemon moves onto the installer in place** (w14): `migrate --config <its daemon.json>
  --root <its root> --instance <name> --from-service <old task or label>` makes it an `--instance` install (root.json,
  its own service, `self_update`) with the same credential. Its sandboxes stay in their folders (only their git is
  re-pointed at the root's clone), the old clone and folders stay, and the old task or LaunchAgent is disabled, not
  deleted. `--cleanup` refuses in place; `--rollback` undoes it. An instance may now run with `--max-unity 0`
  (docs/worker-install.md, "Moving a hand-made one onto it"). Without `--config` nothing changes.
