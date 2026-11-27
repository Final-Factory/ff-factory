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

The cargo registry, its index and git dependencies are one `CARGO_HOME` per machine, inside the install folder (w5501),
shared by every slot and every worker's cargo:

- **Where.** The daemon sets `CARGO_HOME=<root>/cache/cargo` in its own environment at start, so every agent, script and
  build it starts inherits it, and `ffu-slot take` (and `where`) also prints `export CARGO_HOME=...`. A `CARGO_HOME` the
  daemon's environment already gives inside the root stays where it is (LothDesktop's `V:/ffw/tools/cargo`), unless it
  sits in `daemon`, `secrets` or `ffu-runners`, which a fenced worker cannot write. Code: `machine/sharedCaches.ts`
  `workerCargoHome`, `machine/daemon.ts` (the start, before `rootEnv`), `machine/ffuSlots.ts` `envLines`.
- **Why.** On BEAST it used to be the person's `~/.cargo` on C:. A worker under the Windows Low-integrity fence cannot write
  there, so a `cargo fetch` of a crate not yet downloaded failed with "Access is denied (os error 5)" (measured
  2026-11-24, w5499); building with crates already fetched worked.
- **Writable under every fence.** `cache` is a root child: on Windows the daemon labels it Low with `(OI)(CI)`
  (`machine/lowIntegrity.ts` `lowTargets`), so `cache/cargo` and all cargo writes in it inherit Low; Linux Landlock and
  macOS Seatbelt open every root child except `daemon` and `secrets`. The daemon makes the folder before it labels or starts
  an agent.
- **Seeded, read only.** When the home moved (from `~/.cargo`, or a `CARGO_HOME` outside the root), the daemon copies in
  the background, once, what the old one has and the new one lacks: `registry/index`, `registry/cache` (the downloaded
  `.crate` files), `git/db` and `config.toml`/`config`. Not `bin` (the person's installed tools stay where `PATH` finds
  them), `registry/src` (cargo unpacks it again from the cache) or `credentials*` (a login). Each piece is copied into
  `cache/cargo/.seed` and renamed into place, so cargo never sees half of one; a piece cargo made first is kept and the copy
  dropped. The old home is only read: nothing on C: is written, moved or deleted. The daemon log says what it seeded
  (`cargo home: ...`). A seed that cannot read the old home is said there too; cargo then downloads (a cold fetch of ffu's
  crates: 22 s and 1.1 GB, measured on BEAST).
- **Not the runners'.** The ffu CI runners keep their own `<root>/ffu-runners/cargo` (Medium on Windows, not a worker's).
- `cargo install` now lands in `cache/cargo/bin`, which is not on `PATH`; tools a person installed before stay in the old
  home's `bin`, still on `PATH`.
- Tests: `server/cargoHome.test.ts`.

## Where an FFU worker works: a light agent folder (w5924)

An FFU request needs only an agent slot (`needs: agent`), so its worker starts in a **light agent folder** of its own
(`<sandbox_root>/agent-work/agentN`), not in a game sandbox: it takes no game sandbox from game work, and a computer whose
game sandboxes are all full still takes it while an agent slot is free. Its builds still go through an ffu slot below
(`ffu-slot take`), whose warm target is the point of this page. An FFU worker placed in a game sandbox before w5924 moves
to a light folder when it next resumes; its temp folder stays as it was. Details: [machines.md](machines.md), "Light agent
folders (w5924)".

## Use (a worker)

```sh
eval "$(ffu-slot take --branch my-branch)"   # sets FFU_SLOT, FFU_DIR, CARGO_TARGET_DIR, CARGO_INCREMENTAL=0, CARGO_HOME and cds into the checkout
cargo test --workspace --all-features --no-run
ffu-slot release                             # once the work is pushed (a stopped worker's pushed slot frees itself)
ffu-slot list                                # every slot, its branch, and why it is or is not free
ffu-slot take --wait 9 --branch my-branch    # no slot free: wait up to 9 min for one (w5885)
ffu-slot sweep                               # free every slot a worker may take now, saving its holder's work first
eval "$(ffu-slot take --branch other-branch)" # a second checkout: its own slot and target beside the first (w5885)
eval "$(ffu-slot where --branch my-branch)"  # back to the slot on my-branch; plain `where` gives the one used last
ffu-slot release --branch other-branch       # give one back; plain `release` gives back every slot of yours with no work
```

**One slot per branch** (w5885, lothsahn's note of 2026-11-26: "A worker with two checkouts may lease a second ffu slot,
one slot per checkout and per branch, when one is free. The worker's own hold never counts as 'another worker's'"). w5475's
worker held slot4 for its map branch; its Report a Bug branch could not build in slot4's target (two checkouts in one target
overwrite each other's crates) nor in its temp folder (w4258's guard), so it waited on its own slot while three slots sat
free. Now `take --branch <b>` on a branch none of your slots is on leases another free slot, up to `FFU_SLOTS_PER_WORKER`
(2, a guess: the case it came from, and low so one worker never takes a machine's four). With none free, or at that cap, a
slot of yours with no work switches to the branch, as before; when all of yours have work, take exits 4 naming your slots
as yours and the others by their real holders. The guards (`server/ffuTargetGuard.ts`, `server/strayWrite.ts`) open every
slot you hold. Test: `server/ffuSlots.test.ts`, "one worker, two branches".

`take` keeps the slot you already hold on that branch (with no `--branch`, the one you used last). Otherwise it picks a free slot: first one last used on your branch, then the
one used most recently (the warmest target), a slot with no work to save before one whose holder's work must be rescued.
It makes a new slot (a cold target) only when no slot is free. Exit 4 means no slot can be had now: all
`FF_FFU_SLOTS_MAX` slots are held, or the drive has under 40 GB free. Exit 3 is any other failure.

**No free slot: wait, never build elsewhere** (w5885, lothsahn: "Update instructions so workers block on those slots
instead of doing builds in temp directories to workaround and causing space issues"). Until w5885 the exit 3 message said
"Build in your temp folder this time (CARGO_TARGET_DIR="$TMPDIR/ffu-target")", and on LothDesktop on 2026-11-25 five
workers did (w5478, w5475, w5589, w5775, w5788; their transcripts), while 6d0f156a held slot1 all day doing Unity work.
Now a worker that gets exit 4 runs `ffu-slot take --wait <minutes> --branch <b>` (it looks every 30 s; keep it under the
Bash tool's 10 min), or sets a wake_me check-in and ends its turn, then takes again. It never builds ffu in `$TMPDIR`, a
clone or a worktree of its own. A light clone with no cargo build, for reading or a `git merge` only, is fine: it holds no
target (the disk cost was the targets: 15.4 GB in one worker's `$TMPDIR/ffu-target`, w3330).

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

A slot is free when (`machine/ffuSlots.ts` `slotFree`):
- no one holds it, or
- you hold it, or
- its holder no longer runs here (`cleanup-facts.json`, `live`) and its checkout has no uncommitted change and no
  commit missing from origin, or (w5885)
- its holder is on no open request (`owners`, while the daemon is connected to the portal): it finished, or
- its holder stopped, or every request it works on waits (blocked, a question, queued), and the slot went unused for
  `FFU_SLOT_WAIT_GRACE_MS` (30 min), or
- the slot went unused for `FFU_SLOT_IDLE_MS` (2 h), whatever its holder does.

If the facts file is older than 15 minutes, every other holder counts as running.

"Unused" is the newest of the slot's last `take`, its checkout's git files (the index, which `git status` refreshes, HEAD
and its reflog) and its target's profile folders (`slotLastUsed`). Why these limits: the 30 min is the harness's own line
between a short wait and a long one (a wake_me check-in under 30 min keeps a sandbox, a longer one frees it). ffu's pull
request CI took 123 min at the median and 190 min at p90 (measured, 92 runs, `gh run list -R Final-Factory/ffu` to
2026-11-26), so a slot held through a whole CI wait sat idle for hours, and a resumed worker takes one back cheaply: a
slot last on its branch is picked first. The 2 h is a guess, long beside the ffu loop's slowest step (a cold workspace
build, 221 to 366 s), so only a worker that moved on to other work loses its slot.

**Its holder's work is saved first, never dropped** (`rescueWork`). Before a taken slot's checkout is reset, its
uncommitted changes are committed and its tip is kept as branch `rescue/ffu-slot/<slot>-<holder>-<sha8>` in the shared
clone (a local branch, which `fetch --prune` never drops), then pushed to origin (ffu's CI runs on pushes to `main` and
tags only, so the push starts nothing). If the commit fails, the take fails and the checkout stays as it was. A failed
push leaves the branch in the shared clone. `slots.json` lists each rescue for a fortnight (`ffu-slot list`), and the
holder is told once, on its next `take`: `your slot slot1 went to another worker ...; your work there is on branch ...`.
A worker that may lose its slot runs `eval "$(ffu-slot take --branch <b>)"` again at the start of each command rather
than `cd` into a slot path it remembers: `take` keeps the slot it holds, or gives it another.

The `ffu-slot` shim (`machine/ffuSlots.ts`) is written by the machine daemon into the same folder as `ff-leftovers` and
`ff-pr`, which is first on every worker's PATH. Its default is 4 slots per machine (`FFU_SLOTS_DEFAULT_MAX`, a guess),
so 4 × the 16 GB cap is 64 GB at most.

**A cargo build outside a slot is noted** (w5885, warn-only, `server/ffuSlotBuildHook.ts`): when a worker that holds no slot
runs `cargo build`, `test`, `check`, `clippy`, `run`, `bench` or `nextest` outside `ffu-sandboxes`, its next step carries a
note to take a slot or wait for one, at most once per 30 min. A machine with no `ffu-sandboxes` folder is left alone. A
refusal would come in a later, separate change, by lothsahn's lockout rule (warn first).

**A git write in a slot you do not hold is refused** (w6038). In w5681 a worker resumed after a long wait, cd'd into a slot
path from a saved `$TMPDIR` script, and made a merge commit on another worker's branch; five skill lessons had not stopped
it. `take` now points the shared clone's `core.hooksPath` at `machine/ffuSlotHooks/` (FF Factory's own code, which no worker
writes) and writes `slot<N>/holder` (`holder <session>`, `branch <branch>`) beside each checkout whenever it writes
`slots.json`. The hooks (`reference-transaction`, `pre-push`, `pre-rebase`, sharing `slot-guard.sh`) refuse, naming the
slot, its holder and the holder's branch:

- any ref write (commit, merge, cherry-pick, rebase, reset, stash, branch, tag; `--no-verify` does not skip
  `reference-transaction`) and any push, when `FF_SESSION_ID` is not the slot's holder, or the slot is released;
- the same when the holder's checkout is on a branch other than the one `take` recorded (detached is let through: a rebase,
  or the "checked out in another slot" case).

Let through: no `FF_SESSION_ID` (a person's shell, the daemon), a slot with no holder file yet, a fetch (remote-tracking refs),
a checkout's HEAD switch (a symref), and a ref set to the commit it is on (`merge --abort`). FF Factory's own git
(`gitSpawnSync`: `take`, the rescue, the portal's report) runs with `core.hooksPath` on `server/gitHooks` and never meets
these hooks; `ff-pr push` and `merge` run the same check in TypeScript (`slotWriteRefusal`) before any git, since their git
is fenced too. The hooks use shell builtins only (no git call): measured on M5, a commit costs 15 to 20 ms more (14.6 ms
without, 29 to 35 ms with, 40 empty commits each). Not covered: `git reset --hard` and `git checkout -- <path>` rewrite files
before their ref update (git has no hook before them), so the ref stays but the files moved; a merge the hook stops leaves its
files merged (`git merge --abort` puts them back). Recovery if the check ever misfires: `ffu-slot take` rewrites the holder
file, and a shell with `FF_SESSION_ID` unset skips the check.

**On Windows the slots run a native `reference-transaction`** (w6062). Git runs that hook at every phase of every ref
transaction: 7 times for one `git commit` (preparing, prepared, committed; preparing, aborted, prepared, committed), and each
start of Git Bash's `sh` cost about 30 ms on LothDesktop, so the shell hooks added about 210 ms per commit (measured; the
hook already exited at once outside `prepared`, and an `exit 0` shell hook cost the same). `machine/ffuSlotHooks/native/
reference_transaction.rs` is the same check in Rust (std only). `take` on Windows builds it once per version of the hooks
with `rustc` (on PATH, else `CARGO_HOME`, `<root>/tools/cargo` with its `rustup` beside it, `<root>/cache/cargo`,
`~/.cargo`; about 4 s) into `ffu-sandboxes/hooks/<hash>/` beside copies of `pre-push`, `pre-rebase` and `slot-guard.sh`,
and points `core.hooksPath` there; no rustc, or a failed build, keeps the shell hooks (`take` says so). That folder is a
worker's to write, as the shared clone's config already is: the guard stops slips, not a worker set on getting past it.
The daemon does not build it: its rustc would be one a Low worker can write. macOS and Linux keep the shell hooks (about
2 ms a call). Change `slot-guard.sh` and the `.rs` together: `server/ffuSlotGuard.test.ts` runs every refusal on both.
Cost on LothDesktop (measured 2026-11-26, 40 empty commits per hook set, interleaved, under an exclusive bench ticket; the median a commit adds over no hooks, in the two calmest of three runs): the shell hooks added 237 and 296 ms, the native hook 90 and 102 ms. Most of what is left is Windows starting the hook 7 times.

## On the portal (w5912)

Each machine's ffu slots show on its page, in a set of their own under its sandboxes (`web/src/components/FfuSlots.tsx`),
and in `list_sandboxes` and `list_machines` (`server/ffuSlotsView.ts`): for each slot, the holder (its title and request
when the portal knows the session), whether it runs, stopped or is gone, its branch and commit, since when it is held and
when it was last used, its target's size, and whether the hold is **stale**. Stale is `ffu-slot list`'s own judgement: a
held slot `slotFree` calls free (its holder is gone with its work pushed, or stopped or waiting past `FFU_SLOT_WAIT_GRACE_MS`, or idle
past `FFU_SLOT_IDLE_MS`, w5885); the next `take` frees it by itself, so the page has no action.

- The daemon runs `ffu-slot list --json` (`slotsReport`) in a child process every 2 minutes (`FFU_REPORT_MS`,
  `readFfuSlotsReport`), so the `git rev-parse` and `git status` in each checkout never block it, and sends the result in its
  15-second stats (`MachineStats.ffuSlots`). A machine with no `slots.json` sends none.
- A target's size is the one the clean-up pass last measured (the `ffuSized` hook of `planInstallLeftovers`, hourly or on
  a stale pass), never a `du` of its own; a slot not measured yet shows none.
- The page state gets each slot without its `why` sentence (`pageStats`), which the tools keep.

## Clean-up (`server/installLeftovers.ts`, rule `ffu-slot-target`)

The clean-up only ever deletes in a slot's `target`. It never touches the checkout, which may hold work, or the shared
clone. Nothing goes while cargo builds in the target, as `cargoTargetBusy` judges it: a cargo, rustc or linker process
names the target or runs in the checkout's process tree. A write within the settle time (15 min) in its top three levels
stops only the incremental trim and the whole removals: the stale-unit sweep still runs and spares every unit written
within the settle time (w4258: four slots in steady use, 71 GB on LothDesktop, were each written every few minutes, and a
pass on 2026-11-15 freed nothing). A target kept whole over the cap is named in every pass's kept list.

**Anything running from the slot keeps its whole target (w6240).** No sweep, no trim and no whole removal while a process
runs from the slot, as `runsFromDir` (`server/installLeftovers.ts`) judges it: a command line naming the target or the slot
(its checkout included), an executable inside the target, or a working folder inside the slot. The executables and working
folders come from `server/procPlaces.ts`: `/proc/<pid>/exe` and `cwd` on Linux, `lsof -d cwd,txt` on macOS, Win32_Process
`ExecutablePath` on Windows (which gives no working folder, so there the executable and the command line stand for it). A
process list or places that cannot be read keep the target, and `ffuSlotBusyNow` checks the same again right before each
removal, sweeps included. Why: on biscuit, 2026-11-27T00:23:32Z, the sweep took 12.0 GB of slot4's 35.0 GB target at the
15 min window, 62 of the 257 test binaries among it (`deps/redteam_race-b158fae8531a6a53`, `deps/alarms-bdd02d47710ae4cf`),
while its holder ran `python3 tools/run_tests_parallel.py` over them in the checkout; the run died with FileNotFoundError.
The runner's argv named neither the target nor the checkout, so w4258's `cargoTargetRunners` (a command line naming the
target), which let the sweep run beside a long test binary, did not see it.

**The latest build's executables are roots (w6240).** `cargo test --no-run` rewrites only the units that changed: a test
binary whose crate did not change keeps its old time and its old fingerprint, so a window measured from the newest build
(15 min over the cap) left it unreached. The sweep (`server/cargoGraphSweep.ts`) roots the newest executable of each name
in `deps/` (`<name>-<hash>`, no extension, or `.exe`), however old, and so keeps its fingerprint, its `.d`, `.dSYM` or
`.pdb` and everything it was built from. An older binary of the same name (another feature set, an older build) still goes.
Otherwise:

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
The rule runs on every hourly pass (the daemon's `cargo-cap` scope), not only on the daily stale pass or a low one: after
#1148 deployed, LothDesktop's 05:34 UTC hourly pass on 2026-11-25 never looked at slot2 to slot4 (25 to 35 GB each, 11 to
21 GB of it idle `debug/incremental`), because the rule ran only in the full plan (`server/installLeftovers.ts`,
`ffuSlotTargets`).

**A busy target is judged again between passes (w6290).** A pass keeps a slot's whole target while a build or a test runs
in or from it (`cargoTargetBusy`, `runsFromDir`): a rustc reads the rlibs it links, and a running test executable's
siblings are files no unit graph sees in use (w6240). It also keeps one written within the settle time. On LothDesktop the
slots build most of the day, so the next hourly pass often met the same slot busy again: on 2026-11-26/27
(`cleanup-log.jsonl`) slot1 to slot4 were kept at 16.1 to 20.4 GB on 7 passes, and slot4 stayed kept from 15:48 to 17:59
UTC before a pass swept 15.6 GB of it. Now every slot a pass keeps for one of those reasons is planned again, alone, every
`staleOutput.ffuBusyRetryMinutes` (5) until the next pass is due (`machine/ffuBusyRetry.ts`, the `ffu-busy-retry` scope of
`planInstallLeftovers`). The rule is the same one, so the re-check never takes more than an idle pass would. Still busy, the
slot is kept again and stays watched. Once idle, the re-check plans what the pass would take then: the stale units, then
`debug/incremental` over the cap. Each removal still asks `ffuSlotBusyNow` right before its rename.

`staleOutput.ffuBusyRetry` sets the mode. `warn` is the default: it logs `would remove` lines to the clean-up history
(`portal_logs cleanup`, trigger `ffu-busy-retry`) and removes nothing (docs/worker-fence.md: warn-only first). `on` removes,
and only while the stale-output mode is `on` too. `off` stops the re-check. Pruning by age inside a busy target was rejected
because a running rustc or test run can need any file in `deps/` whatever its age. The age window that is safe is the
unit-graph sweep's, and a pass already runs it whenever nothing runs in the target.

Recovery needs no person. A unit removed by mistake is one cargo rebuilds on the next build in that slot, as it does after
any sweep. Setting `ffuBusyRetry` to `off` (portal config `cleanup.staleOutput`) turns the re-check off.

**Released targets first (w6044).** A pass plans and removes the released slots' targets before every slower step (the
`ffu-slots` scope, `cleanupPass`'s `first` step in `server/staleOutput.ts`): a slot no running or resumable worker holds and
nothing runs from, taken whole only. On a low pass a settled one goes, with no sweep or size walk; on any other pass one idle
`ffuSlotIdleDays`. Sweeps, trims and over-cap verdicts stay with the later `cap` or `stale` step, and a held slot is never
touched in the first step. Right before each rename `ffuSlotBusyNow` (`server/installLeftovers.ts`) reads `slots.json` and
the process list again: a slot taken since the plan (holder or take time moved), a cargo build or a program in it, or an
unreadable state keeps the target. With the stale-output mode `dry-run` the step only says its plan; `off` skips it. The
daemon logs `clean-up: ffu slots first (w6044): N item(s) planned in S s, M removed (G GB): ...`. Why: on BEAST,
2026-11-26, three released targets held 190.6 GB (49.2, 57.7 and 83.6 GB) while no pass had finished since 2026-11-25
04:09Z; the 09:10Z low pass was cut off 4 min into its `regular` step, before the ffu rule ran in its `stale` step. Stage 1
(#1353) only said the plan; stage 2 removes it.

**Alone during a pass that is not low (w6044 stage 3).** A low-space tick, an asked pass or a critical one that meets a
pass in flight that is not low (an hourly one) runs the first step alone, at low (`CleanupRunner`'s `firstAlone`,
`server/cleanup.ts`; the daemon's `ffuFirstAlone`, `machine/daemon.ts`): a tick at most every 15 min, a hold (a timed run)
deferring it as it defers a pass. Before it, the runner dropped both (`if (this.running) return undefined`), and the hourly
pass's own first step had run with the 7-day idle rule: on BEAST, 2026-11-26, hourly passes ran 59 to 72 min back to back
(13:22-14:12, 14:13-15:14, 15:16-16:28Z), so six asked passes were refused "already running" (w6115) while a released
slot2 held a 78 GB target. The daemon logs `clean-up: ffu slots first, alone during a pass that is not low (<trigger>, ...)
(w6044): ...`. Stage 3a (#1384) only said its plan; stage 3b removes it with the stale-output mode on (dry-run says it,
off skips it), and writes what it freed to the clean-up history (`cleanup-log.jsonl`, `ffuFirstAlone: true`).

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
w4258 `.cargo/config.toml` routing (25 GB in biscuit's slot1): only with cargo's
`CACHEDIR.TAG`, or (w5499) with the checkout's `.gitignore` ignoring `/target` and cargo's tag in a folder right
inside it: ffu's own scripts point `CARGO_TARGET_DIR` at `target/compat-base`, `target/deploy-base` or
`target/sim-switch-b`, and cargo tags only those (LothDesktop's four slots held 0.8 to 1.9 GB each there, kept as "not
provably build output"). Everything else is KEEP with the reason: a held or busy slot, the checkout and anything else in it, the
slot folder, the shared clone. A clean-up worker takes a target sooner than the daemon's 7 idle days; the next build in the
slot rebuilds it cold (minutes, not seconds). Tests: `ffuSlotCheck.test.ts`.

**A stray `ffu/target` in a held slot (w5796).** Since w5796 the daemon's `ffu-slot-target` rule takes a stray
`slot<N>/ffu/target` too (`installLeftovers.ts` `strayInTreeTarget`), and `check` agrees: whole, once no build runs in it
and nothing in it was written for `ffuSlotKeepHours` (48 h), even in a held slot, or after the settle time in a released
one. It is a build that missed the slot's own target, not its warm cache: a build started from a working folder outside
the slot (cargo reads `.cargo/config.toml` from the working folder up, not from the manifest's), or an ffu script that
named `$repo/target/<dir>` itself (before ffu PR #1154 the three scripts above did). LothDesktop, 2026-11-25: 828 MB to
1.9 GB in three held slots, two untouched for 9 days. Tests: `ffuSlots.test.ts`, `ffuSlotCheck.test.ts` (w5796).

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
min untouched on a low pass, else after `runnerWorkDays` (14). A disk that is not low gets no low pass by itself, so `machine_cleanup` asks for one: its
asked pass counts as low (`server/cleanup.ts` `run`) and takes the folder once untouched 15 min, while no job runs. The
dispatcher has it, and since w5929 so does a worker on a disk clean-up request of its own machine (`Agents.workerCleanup`);
`ff-leftovers` says so (`runnerWorkRoute` in `server/installLeftovers.ts`). It renames the folder aside before deleting
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
