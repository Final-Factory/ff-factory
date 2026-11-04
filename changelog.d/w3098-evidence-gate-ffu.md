- **ffu pull requests get the Evidence check at the merge too** (w3098, after w3097 made pr_evidence.py count FFU's bake and
  render code as art: ffu #222's dark sky passed as "no game code" while its lines had been added only by hand).
  `ff-pr merge`, the merge-on-green pilot (w2045) and the shell guard on a raw `gh pr merge` or API merge in an ffu clone
  now run `pr_evidence.py --repo Final-Factory/ffu --pr <n>` and refuse on anything but exit 0. An ffu PR that touches
  `art/`, ffu-bake or ffu-render sources, ffu-render effects, ffu-client's fx.rs or a `.wgsl` needs its `Reference capture:`
  and `Art language:` lines; any other ffu PR passes the script and merges. Code: machine/evidenceGate.ts `EVIDENCE_GATED`,
  server/guard.ts ghIsEvidenceRepo. Docs: orchestrators.md ("Merge on green, a pilot"). Tests: `evidenceGate.test.ts`.
