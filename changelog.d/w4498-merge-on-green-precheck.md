- **Merge on green refuses a draft PR, or one whose Evidence check fails, when it is armed instead of after green CI** (w4498;
  FinalFactory #3741, #3748 and #3760 were each refused only at the merge, a worker turn each). `blocked_on` with `merge_on_green`
  reads the PR's `isDraft` and runs the merge's own pr_evidence.py check (`ghEvidenceRefusal`). It records nothing and gives the
  fix: `gh pr ready <n>`, or a `## Evidence` section with Kind, a claims table and Not verified. `ff-pr push` warns on a failing check.
