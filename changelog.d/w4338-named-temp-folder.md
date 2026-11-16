- **A worker's delete through a folder it named at the start of the command asks nobody** (w4338, lothsahn: "find a way
  for agents to do what was needed without bash"). w4222's worker waited about 17 hours on a person for
  `K=$(cygpath -m "$TMPDIR/keep"); ...; rm -f "$K"/*strip.png`. The session now answers such a delete itself when the name
  is assigned once, unconditionally, at the start of the command to a folder strictly inside `$TMPDIR`
  (`"$TMPDIR/x"`, `$TMPDIR/x` or `$(cygpath -m "$TMPDIR/x")`) and never changed; anything else still asks. A command that
  sets `IFS` is now refused as well. Docs: self-recovery.md ("A folder named at the start of the command"). Tests:
  `tempDelete.test.ts`.
