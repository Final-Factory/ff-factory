- **A new instance is one command** (w14): `scripts/instance/new.ts` checks the name, port and folder, clones and builds
  the portal, writes its vault key, config and briefs, registers and starts its logon task (Windows) or LaunchAgent
  (macOS), waits for it to answer, adds it to the instance list and prints the owner's next steps (docs/project.md).
  `--dry-run` changes nothing.
