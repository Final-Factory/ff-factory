- Machine updates install exactly the commit the portal verified, never main's head (w5516, the w5452 audit's finding 11):
  the rollout, `machine_update` and the join fetch the installer at that commit and pass `--ref <commit>` / `-Ref <commit>`;
  the installers check that commit out and refuse when they cannot, or when it is not on ff-factory's main; a daemon
  takes a commit over its link only when it is on GitHub's main; and an update counts only when the daemon comes back on
  the verified commit. `/api/health` now says the portal's full `commit`.
