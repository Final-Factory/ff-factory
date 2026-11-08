- **A worker reads its machine daemon's logs and other non-secret daemon files, read-only** (w3670, lothsahn: "Please give workers read
  only access to the logs and other reasonable daemon files it might ever need"). The guard (`server/daemonReads.ts`) lets the shell's
  read-only commands and the Read, Grep and Glob tools into the daemon's `logs`, its code, `sandboxes.json`, `pause.json`, the clean-up and
  update files, and `devdrive.json`, `root.json` and `moved.json` beside it; `daemon.json`, `gh-app/`, `hosts/`, `max-events.jsonl`, the update
  bundles and both `secrets` folders stay closed (now to the read tools too), and writes, deletes and runs there stay refused. Needs the portal
  deploy and each machine's daemon update.
