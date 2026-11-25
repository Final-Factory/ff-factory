- **A standing agent's shell guard judges each tool's options, not only its name** (w5504, the w5452 audit's finding 2; lothsahn: "File it:
  refuse each bypass form, with a test case per form"). `checkStandingShell` allowed read-only programs with options that run code, write a file
  or print the token: `git -c core.pager=…`/`core.fsmonitor`/`alias.*`/`--config-env`, `git fetch --upload-pack`, `git log --output`,
  `rg --pre`, `sed -Ei` and sed's `e`/`w`/`W` commands, `sort -o`/`--compress-program`, `find -fprint0`, `gh api -XDELETE` and
  `gh auth status --show-token`. They and their variants (joined short flags, option prefixes, quoting, `$VAR`/`$'…'` expansion, globs and
  braces that expand into options, `PATH=`/`GIT_*=`/`*_PAGER=` assignments, programs run from a path) are refused now, each with a test case
  in server/standingGuard.test.ts. git, gh api and sed are allowlisted option by option ([docs/standing-agents.md](../docs/standing-agents.md)).
