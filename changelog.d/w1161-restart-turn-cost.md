- **A portal restart no longer bills the CLI's whole running total as one turn** (w1161, lothsahn: "we need to understand why
  and fix it"). The dispatcher's "runaway" turns (59 billed to w605, $1,836) were not hundreds of model calls: they were the first
  turn after each portal restart. A resumed Claude Code process carries the total its transcript saved, and the portal took any
  first total below its own figure for totals that began again, so it counted the CLI's whole running total (about $165 to $215
  each time on the dispatcher and both orchestrators) once more, and fired a needless cost-triggered compaction. The portal now
  keeps the CLI's own total (`SessionInfo.sdkCostUsd`, seeded from `spend.json` at start) and counts a resume's first turn as the
  rise over it; `spend.json` counts totals that grew on every count as a continuation whatever the `restarted` flag says. Past
  records keep their figures. The w605 label itself (harness notices citing "w605") is w1160's fix. Docs: spend.md. Tests:
  `sessions.test.ts`, `spend.test.ts`.
