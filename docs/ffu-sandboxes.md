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
| `ffu-sandboxes/slot<N>/.cargo/config.toml` | `[build] target-dir` naming the slot's target (w4258), written on every `take`: cargo reads config from the folders above where it runs, so a build in the checkout lands in the slot's target even in a shell without `CARGO_TARGET_DIR` |
| `ffu-sandboxes/slot<N>/bin` | where a script copies `ffu-server.exe` to run it (w5442): it has a firewall rule, a temp folder has none |
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

A worker that holds a slot builds only in the slot's target (w4258, lothsahn: "A worker that holds an ffu slot builds in
that slot's target and never in a private $TMPDIR/ffu-target"). The guard (`server/ffuTargetGuard.ts`) refuses a command
that points `CARGO_TARGET_DIR` or `--target-dir` into the worker's temp folder while its session holds a slot, and the
clean-up gives such a worker's temp-folder targets a cap of 0, so one goes once cargo is done with it. A baseline of
another commit (a RED run on main) is built in the slot too: check that commit out there, build, and switch back; both
builds stay warm in the one target, and the sweep below keeps both while either is recent.

Two FFU requests may edit the same file at once (w5197, lothsahn: "Let FFU look requests run at once; each merges main
before pushing, and the later PR fixes conflicts"). When yours shares files with other FFU work in flight, your start
prompt says which and with whom, and a request started after yours on your files is announced to you in a message headed
"[ffu files shared with work in flight (w5197)]". Merge `origin/main` into your branch before every push (`ff-pr push`
does), and if the other pull request merged first, resolve the conflicts in yours. The dispatcher's side:
docs/orchestrators.md, "FFU rows on the same files run at once".

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

The clean-up only ever deletes in a slot's `target`. It never touches the checkout, which may hold work, or the shared
clone. Nothing goes while cargo builds in the target, as `cargoTargetBusy` judges it: a cargo, rustc or linker process
names the target or runs in the checkout's process tree. A write within the settle time (15 min) in its top three levels
stops only the incremental trim and the whole removals: the stale-unit sweep still runs and spares every unit written
within the settle time (w4258: four slots in steady use, 71 GB on LothDesktop, were each written every few minutes, and a
pass on 2026-11-15 freed nothing). A target kept whole over the cap is named in every pass's kept list. A program that only runs from the target (a long test binary from `debug/deps`, with the
`cargo test` and the shell that started it) no longer keeps it whole (w4258): `cargoTargetRunners` finds those, and the
sweep spares the units they run. Otherwise:

| When | What goes |
|---|---|
| No running or resumable worker holds the slot, nothing runs from it, and nothing was written for `ffuSlotIdleDays` (7) | the whole target |
| Every pass | the stale units (below): what no workspace unit built within `ffuSlotKeepHours` (48) of the newest one uses, and superseded object files |
| No running or resumable worker holds the slot and nothing runs from it (released, w5503) | the sweep's window starts at `ffuSlotReleasedKeepHours` (1 h): what the last worker built in its last hour, and the dependencies that used, stay warm; older variants go |
| Over `ffuSlotTargetCapGB` (16 GB), or a low pass | the sweep's window narrows to 24, 6, 1 h, then 15 min until the target fits. An incremental cache no build wrote for the settle time goes on this pass anyway, so it is not counted (w5503) |
| Still over the cap | `debug/incremental`; the whole target only when no worker holds the slot and nothing runs from it (a held one is kept and listed) |
| A low pass (the drive under its soft threshold) | the whole target of a slot no running or resumable worker holds; only `debug/incremental` of a held one |

**The bound (w5503).** A released slot's target goes back to its last worker's last hour of builds within an hour of the
release, and to nothing after `ffuSlotIdleDays`; any slot over the cap is swept down to that slot's 15 min of builds, and
an unheld one goes whole if it still does not fit. A held slot over the cap after that is named in every pass's kept list.
The sweep and the trims that go with one pass are one clean-up item. Before w5503 the incremental trim, an item inside the
swept target, was dropped from the plan, so a slot swept on every pass kept its cache. Measured on LothDesktop at
2026-11-25 04:40 UTC, before w5499 reached it: the slot targets were 4.1, 19.2, 32.1 and 25.6 GB. Of that, 0, 6.5, 19.9
and 12.4 GB was `debug/incremental`, leaving 4.1 to 13.2 GB without it. A dry run of the sweep freed 0 GB from every slot
at the 48 h window, and 8.8 GB (slot2) and 1.4 GB (slot3) at 1 h. A cold workspace test build costs 366 s and an edit
rebuild 150 to 179 s, both with incremental off (measured on BEAST, w5499). So the sweep keeps the
dependencies of the last build rather than taking a released target whole.

### The stale-unit sweep (`server/cargoGraphSweep.ts`, w4258)

Cargo never deletes what an older build left: every feature set, profile and dependency change makes a new unit
(`<crate>-<16 hex>` in `deps/`, `build/`, `incremental/` and `.fingerprint/`) and the old one stays. The sweep is a mark
and sweep over cargo's own records. Each unit's `.fingerprint/<pkg>-<hash>/<kind>.json` lists the fingerprints of the
units it was built from (`deps: [[id, name, public, fingerprint]]`, a bare u64 past a double's precision, so the parser
quotes it first), and its `<kind>` file holds its own fingerprint (the u64's little-endian bytes in hex). The roots are the
workspace's units (`local` holds a `CheckDepInfo`) built within the window of the newest one, plus any unit a running
program names. Everything they reach stays however old; the rest goes, except anything written within the settle time.
On macOS rustc also keeps each unit's codegen objects (`*.rcgu.o`) in `deps/`, and every rebuild leaves new ones beside
the old: an object goes when it has one link (incremental hard-links the objects it reuses) and is over 10 minutes older
than its unit's newest other artifact. One clean-up item lists every entry (`members`), so the log has one line per
target, and an entry in use is skipped alone.

Why 48 h and 16 GB (measured, m5, 2026-11-14, a dry run of the sweep): ffu slot2's target, 8.7 GB with one day of work,
was all live (1308 of 1308 units). Slot3's, 13.3 GB after a week, had every unit live at 48 h and 24 h, but 2.86 GB of
superseded object files; at 6 h 3.68 GB would go, at 1 h 5.25 GB. A fresh target is 5.5 to 6.8 GB (BEAST), and a live
debug profile 4 to 11.5 GB on m5, so 16 GB keeps about two configurations warm and the narrowing windows reach it before
the incremental cache or the whole target is touched. The sweep of an 11.5 GB profile read 2193 fingerprints in about
1 s. The per-worker `cargoTargetCapGB` (8 GB, w3426) still applies to targets in temp folders.

### A runner's job is looked for again before its `_work` goes (w5502)

`ffu-runner-work` checks `runnerJobWhy` when it plans, but `runCleanup` renames the folder aside later, after `endStrays` and
other awaits. A rename fails on a file a job holds open; a job handed out in that gap before it opens one could still lose
its checkout. So `cleanupPass` passes `runCleanup` a `busyNow` check (`runnerBusyNow`, `server/installLeftovers.ts`): for an
item of that rule (it carries its `runner`), `runnerJobWhy` runs again on a fresh process list right before the rename, and a
job found keeps the item (`kept: a job may have started ...` in `failed`; an unreadable list keeps it too). Ben, w5499:
"Don't break a CI run that is in progress". Test: `w3502TimingRunnerCleanup.test.ts`.

### What `ff-leftovers check` and `folders` say (`server/cleanupFolders.ts` `judgeFfuSlotPath`, w4422)

A clean-up worker's `ff-leftovers check <path>`, `folders` and `remove` judge a slot's build output as the rule above
judges the whole target. Before w4422 they called a released slot's `target` and its `debug/incremental` "not a place with
an owner in the ledger" (biscuit, w4283). DELETE: `slot<N>/target`, or a path inside it, of a slot no running or resumable
worker holds (`slots.json`, what `ffu-slot list` reads; a holder that neither runs nor has a request not closed holds
nothing, as the daemon's `holderUp` judges it), with cargo's `CACHEDIR.TAG`, no running process naming the slot (cargo,
rustc, a test binary from the target, a shell in the checkout) and nothing in its top three levels written within the
settle time (15 min). The same goes for a stray `slot<N>/ffu/target` inside the checkout, where builds landed before the
w4258 `.cargo/config.toml` routing (25 GB in biscuit's slot1), which the daemon's sweep never looks at: only with cargo's
`CACHEDIR.TAG`, or (w5499) with the checkout's `.gitignore` ignoring `/target` and cargo's tag in a folder right
inside it: ffu's own scripts point `CARGO_TARGET_DIR` at `target/compat-base`, `target/deploy-base` or
`target/sim-switch-b`, and cargo tags only those (LothDesktop's four slots held 0.8 to 1.9 GB each there, kept as "not
provably build output"). Everything else is KEEP with the reason: a held or busy slot, the checkout and anything else in it, the
slot folder, the shared clone. A clean-up worker takes a target sooner than the daemon's 7 idle days; the next build in the
slot rebuilds it cold (minutes, not seconds). Tests: `ffuSlotCheck.test.ts`.

## Incremental off (w5499)

Since w5499 a slot builds with cargo's incremental compilation off, as ffu CI does (`ci.yml`, `CARGO_INCREMENTAL: 0`): the
slot's `.cargo/config.toml` says `incremental = false` and `ffu-slot take` exports `CARGO_INCREMENTAL=0`. A worker that
wants it back for a tight edit loop runs `export CARGO_INCREMENTAL=1` in its shell. The clean-up drops a slot's
`debug/incremental` once no build wrote it for the settle time, held slot or not.

Why (all measured on BEAST, 2026-11-24, ffu 7d89d72a, 32 threads, exclusive bench ticket t00008552; `cargo test
--workspace --all-features --locked --no-run` into a fresh target, then two rounds of a one-line edit in
`crates/ffu-sim/src/sector.rs`):

| | incremental on | incremental off |
|---|---|---|
| Clean build | 447.6 s (a `du` of mine ran beside it: high) | 366.3 s |
| Target after the clean build | 14,220 MB (5,144 of it `debug/incremental`) | 9,126 MB |
| Edit rebuild 1 / 2 | 99.0 s / 90.5 s | 179.3 s / 150.3 s |
| Target after the two edits | 16,474 MB (7,374 incremental) | 9,150 MB |

The slots in use grew far past that: BEAST slot1 24.1 GB (8.7 GB incremental), slot2 55.0 GB (38.1 GB incremental, 2004
unit folders: each feature set and flag change makes new ones); LothDesktop's four 20.4 to 24.5 GB, 88 GB in all. The price is
an edit rebuild about 60 to 80 s slower. Release builds were never incremental, so `ffu-headless hashcheck` is unchanged: its
release build with `CARGO_INCREMENTAL=0` matched `golden/hashcheck.txt` at 1, 4 and 16 threads (hash b5f686367612b320).

Rejected: one shared `CARGO_TARGET_DIR` for all slots. Cargo 1.94 locks the build folder ("Blocking waiting for file lock on
build directory", measured: a second `cargo check` waited for the first), branches overwrite each other's units, and the
Windows Firewall rules name each slot's own `target/.../ffu-server.exe` (w5442). sccache: each target still keeps its own
copy of every artifact, so it frees no disk; it does not cache incremental crates; and its server is one more process to
leave behind.

## FFU runners' job folders and the integrity label (w5499)

`ffu-runners` carries Windows' Medium integrity label with no-write-up (`icacls F:\ffw\ffu-runners`: `Mandatory
Label\Medium Mandatory Level:(OI)(CI)(NW)`, inherited by `_work`), so a fenced worker at Low integrity gets EPERM on every
file there, job or no job. `ff-leftovers remove` of a runner job folder therefore says the daemon takes it: the daemon runs
at Medium, and its rule `ffu-runner-work` (`server/installLeftovers.ts`) removes a job folder while no job runs, after 15
min untouched on a low pass, else after `runnerWorkDays` (14). It renames the folder aside before deleting
(`server/renameAway.ts`), and the rename fails on a file a job holds open, so a running job keeps its folder. It took
LothDesktop's 9.9 GB `_work\ffu` at 2026-11-24 19:34 and 2026-11-25 03:24 UTC (portal clean-up log); a CI job builds it
again.

## Cargo's home on the worker fence

A fenced worker on Windows cannot write the user's `~/.cargo` (on C:): a `cargo fetch` of a crate not yet downloaded
there failed with "Access is denied (os error 5)" (BEAST, 2026-11-24). Building with the crates already fetched works.
The runners use `<install>/ffu-runners/cargo`.

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

## Windows Firewall: ffu-server (w5442)

lothsahn, 2026-11-24: "What ports does ffu-server need? These should be added for all the ffu sandboxes so that it can
start servers always".

Windows Firewall adds inbound Block rules for a new program path the first time it listens beyond loopback, and a block
beats any allow, so a shard on a fresh slot could not take a peer from another PC. The worker install and every tools
rollout keep the group **"Final Factory ffu-server"** (`scripts/worker/firewall.ps1 -FfuServer`, the paths from
`machine/ffuSlots.ts` `ffuServerExes`): one inbound TCP allow rule, every profile, from Tailscale only (`100.64.0.0/10`,
`fd7a:115c:a1e0::/48`; loopback is never filtered), for each of

- `ffu-sandboxes\slot<N>\target\debug\ffu-server.exe` (a dev build),
- `ffu-sandboxes\slot<N>\target\release\ffu-server.exe` (release and bench),
- `ffu-sandboxes\slot<N>\bin\ffu-server.exe` (a script's copy),

for N = 1..4 (`FFU_SLOTS_DEFAULT_MAX`; slot ids are the lowest free number), whether or not the slot exists yet, so a new
slot is covered. The rules go by program, not port: ffu-server's ports come from flags and port 0 picks a free one.

Its listeners, all TCP (ffu has no UDP socket): `--listen` (the client port, default `127.0.0.1:7777`), `--peer-listen`
(a shard's peer port; `g3.sh` and `soak.sh` use `47100+k` for shard k), `--standby-listen`, `replica --listen`,
`directory`'s own address in `--peers`, `proxy --listen`; `--control` is loopback only. A copy anywhere else (a temp
folder, `C:\ProgramData\ffu\soak-bin`) has no rule: run it from the slot's target or `bin`. Macs (firewall off) and
Linux need nothing.
