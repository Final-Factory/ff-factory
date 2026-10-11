- **An update keeps a Dev Drive machine's sandbox root and seed** (w1038, found on LothDesktop after the 3bc7a07 deploy): root.json lost its
  `devDrive` record on the first re-run after the move, so the automatic update took no drive and reset `sandboxes.root` and `librarySeed` from V: to
  D:. The record is now carried (`manifestFor`), and a root.json that lost it is rebuilt from `devdrive.json` and the VHDX, so the next update restores the
  drive's paths. Tested (an update of a Dev Drive machine, a wiped root.json). docs/worker-install.md "The Dev Drive".
