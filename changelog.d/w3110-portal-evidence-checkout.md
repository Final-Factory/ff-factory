- **The merge-on-green pilot finds pr_evidence.py again** (w3110). Its Evidence check runs in the portal's own process, on
  the portal VM, which has no plugin cache, no FF_SKILLS and no worker root, so since w3088 every gated merge was refused
  with "no pr_evidence.py found" (FinalFactory #3186 and #3187, ffu #237 on 2026-11-04), whichever machine the worker was on.
  The portal now keeps a shallow checkout of final-factory-agents' master in its data folder, fetched before each check,
  and runs the script from it; with no checkout and a failed clone the merge is still refused. The portal VM's packages now
  name python3, which the script runs under. Code: machine/evidenceGate.ts portalPrEvidence, server/index.ts. Docs:
  orchestrators.md ("Merge on green, a pilot"). Tests: `evidenceGate.test.ts`.
