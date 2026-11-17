- **The push guard reads only `git push` as a push** (w4533): the git subcommand is found past git's own global options
  (`-C`, `-c`, `--git-dir`, `--no-pager`, …), so `git stash push -m w4528` in a `$TMPDIR` clone is no longer refused as a
  push to remote "w4528" of the game repo. Real pushes, `git -C <clone> -c k=v push` included, are judged as before.
  Tests: `guard.test.ts` ("w4533", the refused command as its fixture).
