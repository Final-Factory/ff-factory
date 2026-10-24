- **A machine's sandbox count is how many are in use, not how many exist** (w2067, lothsahn: "Why does biscuits show 3 out
  of three sandboxes but two of the slots are empty?"; on the format: "just say 1/3. Don't be so verbose"). The sidebar and
  Overview read `1/3 sandboxes`: sandboxes in use (not FREE) of the limit, with in use, free and how many are made in the
  hover. In use is list_sandboxes' own FREE, which the portal now sends with each sandbox (re-sent within 5 seconds when it
  changes), so the page and the agents' tools always agree; the page no longer works out free by itself. list_sandboxes'
  machine headers read `1/3 sandboxes in use, 2 made` and list_machines `sandboxes: 1/3 sandboxes in use, 2 made in <root>`,
  the made count only when fewer than the limit; their free count now also leaves out a sandbox spoken for, handed over or
  under a bench lock, as each sandbox's FREE mark already did. Tests: `fleet.test.ts`, `machineSandboxes.test.ts`,
  `e2e/sandboxCount.spec.ts`.
- **The Overview board's free line draws FREE as a pill the height of its sandbox chips** (w2067's design critic: the square
  tag beside the round chips read as mismatched).
- **`asOnLinuxCi` swaps whole paths only** (`scripts/coordinatorContext.ts`): a worker's clone at `<tmp>/ff` was a prefix of the
  test's own `<tmp>/ffsb-context-*`, so the w1158 budget test read the dispatcher's brief 63 characters long on that machine
  only. Test: `coordinatorContext.test.ts` (w2067).
