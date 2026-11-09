# ffu sandboxes (w3764)

lothsahn, 2026-11-08: "Can we have a build cache that's stored and shared across workers or within workers so they don't
have to keep creating ffu stuff in temp? Can we have ffu sandboxes like final factory sandboxes but in a different folder?"

A worker on Final-Factory/ffu (the Rust engine) leases an **ffu slot**: a checkout with a cargo target that the last
worker left warm. Before this, every worker cloned ffu into its temp folder and built cold (221 s and 6.8 GB on BEAST,
measured), and the clean-up deleted the target when the worker stopped.

## Layout

Under the worker install folder (`FF_WORKER_ROOT`: `F:\ffw` on BEAST, `V:\ffw` on LothDesktop, `~/ffw` on macOS and Linux):

| Path | What |
|---|---|
| `ffu-sandboxes/repo` | one bare clone of ffu per machine, fetched under the lock on every `take` |
| `ffu-sandboxes/slot<N>/ffu` | a git worktree of it: the worker's checkout |
| `ffu-sandboxes/slot<N>/target` | the slot's `CARGO_TARGET_DIR`, kept between workers. It sits outside the checkout, so a reset or a `git clean` never touches it |
| `ffu-sandboxes/slots.json` | each slot's holder (the session id), branch and last use |
| `ffu-sandboxes/.lock` | a folder made atomically around every change; another worker takes it over after 15 min |

The cargo registry and git cache stay in the machine's `CARGO_HOME`, which already holds one per machine. On BEAST that
is `~/.cargo`; on LothDesktop it is `V:/ffw/tools/cargo`. A cold fetch of ffu's crates took 22 s and 1.1 GB (measured,
BEAST).

## Use (a worker)

```sh
eval "$(ffu-slot take --branch my-branch)"   # sets FFU_SLOT, FFU_DIR, CARGO_TARGET_DIR and cds into the checkout
cargo test --workspace --all-features --no-run
ffu-slot release                             # once the work is pushed (a stopped worker's pushed slot frees itself)
ffu-slot list                                # every slot, its branch, and why it is or is not free
```

`take` keeps the slot you already hold. Otherwise it picks a free slot: first one last used on your branch, then the
one used most recently (the warmest target). It makes a new slot (a cold target) only when no slot is free. Exit 3
means no slot can be had: all `FF_FFU_SLOTS_MAX` slots are held, or the drive has under 40 GB free. In that case,
build in `$TMPDIR` as before.

Your branch is checked out from `origin/<branch>`, or from a new branch made from `origin/main`. A local branch that
holds commits origin lacks is kept as it is. If another slot already has your branch checked out, you get a detached
checkout at its tip, because git allows a branch in one worktree only; push it with `git push origin HEAD:<branch>`.

A slot is free when:
- no one holds it, or
- you hold it, or
- its holder no longer runs here (`cleanup-facts.json`, `live`) and its checkout has no uncommitted change and no
  commit missing from origin.

If the facts file is older than 15 minutes, every other holder counts as running. A stopped holder's unpushed work
keeps the slot theirs.

The `ffu-slot` shim (`machine/ffuSlots.ts`) is written by the machine daemon into the same folder as `ff-leftovers` and
`ff-pr`, which is first on every worker's PATH. Its default is 4 slots per machine (`FFU_SLOTS_DEFAULT_MAX`, a guess),
so 4 × the 16 GB cap is 64 GB at most.

## Clean-up (`server/installLeftovers.ts`, rule `ffu-slot-target`)

The clean-up only ever deletes a slot's `target`. It never touches the checkout, which may hold work, or the shared
clone. A target in use always stays, as `cargoTargetBusy` judges it: a process names the target or the checkout, or
something in its top three levels was written within the settle time (15 min). Otherwise:

| When | What goes |
|---|---|
| No running or resumable worker holds the slot and nothing was written for `ffuSlotIdleDays` (7) | the whole target |
| The target is over `ffuSlotTargetCapGB` (16 GB), on every pass | `debug/incremental` when that brings it under the cap, else the whole target |
| A low pass (the drive under its soft threshold) | the whole target of a slot no running or resumable worker holds; only `debug/incremental` of a held one |

The per-worker `cargoTargetCapGB` (8 GB, w3426) still applies to targets in temp folders. Slot targets are kept warm on
purpose, so they get their own, larger cap.

## Measurements behind it (BEAST, 2026-11-09, ffu 9e10964, 32 cores, a shared bench ticket)

Every number in this table was measured once, on a machine where other work was also running (the CPU load column is
the load before each leg). Treat them as one sample.

| Leg | Time | Disk | Load before |
|---|---|---|---|
| `cargo fetch` into an empty CARGO_HOME | 22.3 s | registry 1.1 GB | 11% |
| cold target, warm registry (`cargo test --workspace --all-features --no-run`) | 221.1 s | target 6.8 GB | 22% |
| warm, nothing changed | 0.6 s | | 70% |
| warm, one edit in ffu-sim | 60.2 s | | 10% |
| warm, switch to 5 commits back | 92.5 s | | 23% |
| warm, switch to two days back (273 files differ) | 321.2 s | | 80% |
| warm, back to head | 44.4 s | target 21.4 GB after the three switches | 65% |
| tests: ffu-sim / the whole workspace (run, warm) | 2.2 s / 779.4 s | | 59% / 50% |
| release ffu-headless cold / warm (on the warm debug target) | 26.8 s / 0.2 s | 21.9 GB | 58% / 33% |
| one target shared by two checkouts: old branch, then head again | 40.0 s, 4.1 s | | |
| both at once, each after an edit | 45.8 s and 74.1 s | | 30% |
| sccache (v0.19.0, `CARGO_INCREMENTAL=0`): fill, then a cold target with the warm cache, then a two-day-old branch | 258.7 s, 215.2 s, 247.0 s | sccache 0.9 GB, target 4.1 GB | |

What the design takes from them:

- **A warm slot saves minutes per worker.** A warm target needs 0.6 to 92 s for a build near main, against 221 s cold.
  The wait grows with how far the slot's last build was from yours, which is why `take` prefers a slot last used on your
  branch.
- **sccache is out.** It got 0 Rust cache hits in all three runs, including the identical source in a new target. Only
  the C/C++ build-script compiles hit (74 of 416). A cold target with the warm cache took 215 s, against 221 s without it.
- **One target per slot, not one shared target.** A shared target worked: the two concurrent builds finished, and
  switching between its branches was cheap (40 s and 4 s). But one target serving several branches grew to 21.4 GB after
  three switches. The cap would then trim it constantly, and every build on it waits behind cargo's lock. The lock
  count in the table is 0 only because the builds ran with `--quiet`, which hides cargo's "Blocking waiting for file
  lock" message, so it does not show whether the builds waited.
- **The cap is 16 GB.** That is about 2.4 × a fresh target (6.8 GB), so roughly two branches stay warm. With the default
  of 4 slots the worst case is 64 GB.

The Mac leg (the same script, `measure-portable.sh`) was handed up as its own request. On w3747 (ffu CI on FFBox),
lothsahn asked for ffu caches "just like the unity linux builds, saving them in the same folder (but possibly with
different names)". The names here (`ffu-sandboxes/`, rule `ffu-slot-target`) are for workers' machines only and do not
collide with that cache.
