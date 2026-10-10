- **`npm run prepush`, the check workers run before every push** (w924, lothsahn: "yes, have the workers do #1"): the
  typecheck, shellcheck on the VM scripts (`lint.sh --shellcheck-only`), gitleaks on `origin/main..HEAD` and the noreply
  identity check, with a loud SKIPPED for a tool the machine lacks. CLAUDE.md (new) tells agents to run it.
  `scripts/prepush.test.ts` proves it catches a planted shellcheck finding, fake key and personal email; CI's checks job
  installs gitleaks for it.
