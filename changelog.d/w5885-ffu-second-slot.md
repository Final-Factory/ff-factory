- **A worker with two ffu checkouts gets a slot for each** (w5885, lothsahn: "A worker with two checkouts may lease a
  second ffu slot, one slot per checkout and per branch, when one is free"). `ffu-slot take --branch <b>` on a branch none
  of the worker's slots is on now leases another free slot (up to 2 per worker) instead of waiting on the worker's own;
  `where` and `release` take `--branch` (and `release --slot`). The no-slot message names the worker's own slots as its own
  and the rest by their real holders, and the temp-folder target guard opens every slot it holds.
