- **A wait on a machine's update clears when the machine was offline at the time it was set** (w4672). A deploy gate
  (`blocked_on` with deploys [machine id]) records the commit the machine's daemon runs and clears when another runs. The
  portal knew a daemon's commit only while it was connected, so a gate set while the machine was offline recorded none and
  never cleared: w4672's gate on LothLaptop stayed Blocked after LothLaptop updated twice over its link (e3ca99307 to
  37b37a798 to 549682bb3 on 2026-11-19). A gate now starts from the commit the daemon ran when last connected (its
  record's `info.daemon`), and a machine gate with no commit clears once that daemon runs the portal's own commit, which
  also frees gates set before this fix. Tests: `blockers.test.ts`.
