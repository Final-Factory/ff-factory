- **No merge path skips the Evidence check** (w3088, after #3180 merged on green CI with its `## Evidence` section still
  failing: the worker's `pr_evidence.py --pr 3180` had no `--repo` and printed only a usage error). Before merging a
  Final-Factory/FinalFactory pull request, `ff-pr merge`, the merge-on-green pilot (w2045) and the shell guard on a raw
  `gh pr merge` or API merge run `pr_evidence.py --repo <repo> --pr <n>` with the newest copy on the machine, and refuse on
  anything but exit 0 (a FAIL, a usage error, a gh failure, no script), naming the failing lines. A pull request with no
  game code or assets passes the script, so it still merges; other repositories are not checked. Code:
  machine/evidenceGate.ts. Docs: orchestrators.md ("Merge on green, a pilot"). Tests: `evidenceGate.test.ts`.
