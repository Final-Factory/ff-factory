- **A junction made by a Low-integrity process is seen as a link** (w5915): every BEAST worker makes junctions whose target
  is `\??\Global\F:\...`. Node's `lstat` called them plain folders, `readlink` failed with EINVAL, and the JavaScript
  `realpath` did not follow them. So tempDelete's guard passed a delete through such a link out of the temp folder, and
  devdrive, the worker installer, leftovers and secretGuard all misread them. One check, `server/fsLink.ts` (`isLink`,
  `linkTarget`, `removeLink`), now sees them, using the native realpath.
- **The test suite runs on a worker's Windows computer** (w5915):
  - A worker's own session variables no longer leak into the tests (scripts/testEnv.ts).
  - Shell scripts are checked out with LF endings (`.gitattributes`), so prepush's shellcheck passes on Windows.
  - Tests that read this machine's host name, paths or game data no longer depend on them.
  - The live Git Bash tests use the agents' own Git Bash (`CLAUDE_CODE_GIT_BASH_PATH`); Program Files' msys bash dies at
    Low integrity.
  - The portalLogs symlink checks run only where the account may make a symlink.
  - claudeHome's test waits for the claude it ended.
  - The deploy notice's release test gives its git a test computer's time budget.
