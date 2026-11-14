- **Deleting a login drops its device approvals** (Lens Scout factory's w10): `userCli.ts delete` now also removes the
  login's records from `data/devices.json` (pending, approved and denied) and names how many in its answer, so a
  deleted member's pending request no longer stays in the owners' bar. The owners' device bar also asks again as soon
  as its tab comes back into view, instead of at its next 20 s tick.
