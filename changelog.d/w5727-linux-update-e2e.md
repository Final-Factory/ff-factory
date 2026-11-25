- **CI now proves a Linux daemon updates over its link** (w5727, follow-up of w5715). The worker-update job gains an
  ubuntu-latest leg: `link-e2e.ts` installs a test root under a systemd user unit, as FFBox and biscuit run it, then
  updates it over its link, rolls back a broken update, restarts and unloads it, and checks the job ran as a transient
  `systemd-run --user` unit. It also installs a daemon from main before #1206 (5790dce0) and updates that one over its
  link, on every OS. `update-e2e.ts` checks a Linux unit's PATH keeps its order through `install.sh --update`.
