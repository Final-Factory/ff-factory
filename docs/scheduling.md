# Scheduling: big machines build, small machines time (w1996)

lothsahn, 2026-10-24: "Take a step back, look at the scheduling design, and figure out how to efficiently use the machines
with a small number of slots for jobs that do exclusive locks and the machines with a large number of slots to do builds and
functional runs. We're wasting system resources like crazy locking beast down to a single timing job."

**TL;DR:** an exclusive bench turn closes every other editor and stops every build on its computer
(`machine/benchTurn.ts`, w1829/w1860), so a turn on BEAST idles up to 5 agent slots and one on LothDesktop up to 9. Since
w1969 a worker on a big computer must ask `timed_place` first, and the ask hands the leg to a small computer, where **a
new worker rebuilds both sides** (a slow laptop build in the small computer's only seat) and then times them. The
missing step was moving the *build* there: `timed_run` (w1946) already ships builds to a computer and times them under
that computer's exclusive ticket, but only to a play-only computer. This change lets `timed_run` go to every small
Windows computer that takes timed runs (LothLaptop today, desktop-coosego when it is up), and makes `timed_place` send a
Windows player A/B there: the worker builds both players where it is, under shared tickets, and the small computer's
daemon times them. No seat is taken on the small computer, and nothing waits for one. Legs `timed_run` cannot play (a
snippet timed in the editor, a Performance test, a Mac player) keep w1969's hand-off.

## 1. The flow before this change

Read from the code at ff-factory `78e67f5d` and the game repo at `master`, and from LothDesktop's bench history.

| Step | Where | What happens |
|---|---|---|
| A request is placed | `server/placement.ts` `pickComputer` (476), `timedRank` (248), `timedLine` (603); `shared/capacity.ts` `needsTimed` (115) | The dispatcher picks the sandbox with `start_agent`; the Capacity block names the next computer. A request counts as timed only from its words (`TIMED_WORDS`), so most timed legs start wherever their code work went (w1969 measured `needsTimed` false for w1908 and w1891, both of which held timed legs). |
| A pair run | `server/orchestrators.ts` `filePair` (3113), `server/agents.ts` `startPairLegs` | Both legs start together on computers with room (w1945); `timed` keeps them off m5. |
| A worker reaches a timed leg | `server/timedAsk.ts` `decideTimedPlace`, the guard `checkTimedAsk` (`server/launch.ts` 427) | On a big computer (more than `SMALL_TIMED_MAX_AGENTS`, 4, agent slots) the guard refuses the ticket-taking commands until the worker asked. "here" for a small computer, a `same_machine` reason, the release lane and the nightly, or no small computer online; otherwise "elsewhere". |
| A leg pinned to one computer | `server/machinePin.ts` `machinePinOf`, `pinnedLegStep` (`server/timedLegPlace.ts`), `timed_place` `machine` | w2521: a pin (timed_place's `machine`, or "must run on X" in the constraints) answers here only on X, queues the leg on X alone, never widens, and keeps start_agent, the queue action, the room move and the relocation off every other computer (docs/machines.md). |
| Elsewhere, as a leg | `Orchestrators.fileTimedLeg` (3135), `newTimedLeg` | A new request "Timed leg for wNNN", Queued for the small computers. Its new worker **builds and times both sides there** and reports "For wNNN:". After 60 min (`TIMED_LEG_WAIT_MS`, `timedLegBound`) the leg may go to any computer that takes timed runs, big ones included. |
| Elsewhere, by `timed_run` | `server/timedRuns.ts`, `machine/timedRunPack.ts`, `machine/timedRunner.ts` | Only with `via: "timed_run"` and only to a **play-only** computer: the worker's daemon cuts its builds into SHA-256 pieces, sends the ones the portal lacks, and the timing computer's daemon lays them out, holds its exclusive ticket and plays the legs. |
| The bench queue | the game repo's `scripts/bench/bench_queue.py`; `machine/benchQueue.ts` | One queue per computer. Shared tickets run together; an exclusive one runs alone; one exclusive turn and one shared group alternate per priority (w1628); a turn lasts 30 min while someone waits (w1832); shared work waits one exclusive turn at most (w1962). A computer whose agent cap is 1 (`single_worker`) has no turn limits. |
| An exclusive turn | `machine/benchTurn.ts` | The daemon closes every other sandbox's editor, asks every other worker's player to quit and ends other sandboxes' batch Unity runs, then starts the editors again after the turn. |

So the expensive part, the turn, already goes to small computers when a worker asks. But the hand-off costs a whole
worker on the small computer: a new session, a checkout of both commits, two player builds on a laptop (LothLaptop's
only seat), then the timing. While that worker builds, the seat holds no timing at all, and any other timed leg queues
behind it. And a leg Queued for LothLaptop waits for its only seat: at 05:30Z on 2026-10-24 that seat was held by w1981's
untimed pair leg while w1985 and w1892 queued for it (the w1995 brief; w1985 widened to the big computers after 60 min,
portal journal 05:27:46Z "widened timed legs past their wait bound: w1985").

## 2. What it cost (measured)

LothDesktop's own bench history (`V:\ffw\tmp\bench.queue\history*.jsonl`), 2026-10-23 05:30Z to 2026-10-24 05:36Z,
computed by `bench_waste.py` (the measure `machine/benchHours.ts` now reports to the portal):

| | LothDesktop |
|---|---|
| Exclusive tickets | 42 |
| Exclusive hours | 3.29 h |
| Shared tickets' waits behind them (builds, editor starts) | 6.75 h |
| Idle slot-hours (each hold × the other sandboxes holding a shared ticket during it; a lower bound) | 8.08 slot-h |
| By request | w1853 2.22 h, w1785 0.40 h, w1788 0.35 h, w1898 0.26 h, w1789 0.06 h |
| Exclusive waits (take to grant) | median 0.3 min, p75 4.3, p90 28.1, max 60.0 |
| Exclusive holds | median 1.3 min, p90 15.9, max 29.9 |

w1853's holds were player A/Bs ("UI-w1155-panel-open on the fix, alone", 15-30 min each, idling 2 to 4 other sandboxes
each), exactly what `timed_run` plays. w1898's were editor Performance tests (`unity: w1898 assigner perf`), which it cannot.

BEAST's history is on BEAST only; the portal had no copy. The daemons now send their hourly figures (below,
"Measuring it"), and the BEAST numbers for this report come from that, after the deploy.

## 3. The model

1. **A timed job is a build step and a timing step.** The build runs where the worker is, under shared tickets: a big
   computer builds faster and builds beside other work. Only the timing step needs a quiet computer.
2. **The timing step goes to a small computer by `timed_run` when it is a Windows player A/B.** `timed_run` targets every
   computer that takes timed runs (never m5, w1861), runs Windows players, and is small: play-only ones first (they idle
   nobody), then small worker computers (at most `SMALL_TIMED_MAX_AGENTS` agent slots) by w1872's order, fewest runs
   ahead first. A worker computer's daemon takes its exclusive ticket **through the bench queue** (`bench_queue.py hold
   --mode exclusive --reason timing`, priority from the asking worker's request), so the queue's order, its 30-minute turn
   and BenchTurn's quiet machine apply as for any timed leg there. It borrows a sandbox's player-slot pair (whose firewall
   rules exist) that no live lease holds, only during its turn, leased and marked so the sandbox's next launch refills it.
   Both arms run on that one computer, interleaved, so the comparison is same-machine by construction.
3. **Everything else timed keeps the hand-off** (`timed_place` with `via: "leg"`): a snippet timed in the editor, a
   Performance test, a profiler capture, a Mac player (m3). The new worker builds there; that is the case where the code,
   not a player, is timed.
4. **The ask decides by itself.** On a big computer, `timed_place` with no `via` and a `timed_run` computer online answers
   "elsewhere" with that computer for a Windows player A/B, and says to ask again with `via: "leg"` for anything else; the
   guard refuses local exclusive tickets meanwhile.
5. **Untimed work off a small computer's only seat while timed work queues for it** is w1995's change (ff-factory #626:
   a small computer's last free sandbox is held for the timed work Queued for it, 20 minutes at most, and the game repo's
   bench queue refuses an exclusive timing ticket on a big computer until its worker asked). With `timed_run` most timed
   legs need no seat there at all, so that hold matters only for the legs that still go to a worker.
6. **A pair holds a slot only while it can start soon** (lothsahn's audit note on w1983, 2026-10-24 06:3xZ: biscuit's one
   free sandbox held for a w1826 pair leg, and the w1986 pair, since 03:57Z while about 15 single-leg requests waited,
   because no second computer had room). His rule: hold a computer's slot for a pair only while its other computers are
   free too, or due to free within a short window; otherwise the slot goes to the next single-leg request. Where it stands
   in code: a queued pair request's hold already lapses 20 minutes after that computer's room began
   (`Agents.pairHoldProblem`, `PAIR_HOLD_MS`, w1983 #621). A pair's **held leg** (w1863: `legs` held for named computers)
   has no such bound: `roomShares` (`shared/workState.ts` 589) gives it a room slot at its place in the queue whether or not
   its partner can start, so the ledger reads "biscuit has room, but it goes first to w1826" for every request behind it.
   The fix the design takes: a held leg, like a queued pair, takes a slot only while its partners have room now or will
   within `PAIR_HOLD_MS` (a partner sandbox whose worker is between turns with a check-in or a CI wait due inside the window
   counts as freeing), and the same window bounds it from when that computer's room began. That code is 7fadacb8's
   (w1983/w1995), so it lands there, not in this change.
7. **When nothing small is free.** A `timed_run` waits in the small computer's own queue: it never goes to a big computer.
   A hand-off leg keeps w1969's 60-minute bound, then may go to a big one.

## 4. The questions, settled

- **The wait bound.** On LothDesktop, a busy 10-slot computer, an exclusive ticket waited a median of 0.3 min and 28 min at
  p90; the worst was 60 min. A turn is capped at 30 minutes, and a shared group at 60 once a timed leg waits (w1832), so
  a ticket waits at most one turn and one group: 90 minutes in theory, 60 measured. Running the leg on a big computer
  instead costs its whole turn times 5 to 9 slots, so waiting is cheaper than any big-computer turn longer than about 1/5
  of the wait. **A `timed_run` waits in the small computer's queue with no bound;** a hand-off leg keeps 60 minutes (the
  measured maximum), as w1969 set it. A small computer that is offline moves the run to the next one.
- **Are results from different small computers comparable?** Not in absolute milliseconds: different CPUs, GPUs, memory
  and core counts (sourced: the game repo's `Documentation/Bench-Lock.md` and every `timed_run` report say "compare only
  with the same machine's own"; a busy machine swings 2 to 3 times, `specs/w824-vision-fingerprint-preview/BENCH-NOTES.md`
  84-96). An A/B's ratio usually transfers between computers, but not reliably for work whose cost depends on cache size or
  core count (a guess: no paired cross-machine run exists to measure it). So both arms of a comparison always run on one
  computer: a `timed_run` plays both, and a later run that compares against an earlier one names that computer
  (`machine`).
- **How much of BEAST's timing must stay there.** Only what is about BEAST: w1829's demonstration of BEAST's own bench lock
  (asked with `same_machine`, journal 03:02:40Z), the urgent release lane and the nightly (exempt, `decideTimedPlace`), and
  a comparison whose earlier arm already ran on BEAST (`same_machine`). Every player A/B and editor timing leg on
  2026-10-23/24 whose words we have (w1908, w1891, w1785, w1853, w1898) measured code, not the computer. The hourly
  figures (below) give the hours after the deploy.

## 5. Measuring it

Each daemon reads its bench history every hour and sends the portal one row per hour: exclusive seconds, holds, idle
slot-seconds, shared waits behind exclusive turns, shared granted time and the requests that held it
(`machine/benchHours.ts`). `portal_logs` source `bench_hours` (machine, since, until) shows them, so the before and after
exclusive hours on BEAST and LothDesktop are read from the portal, not from each machine.

### After the deploy (measured, `bench_hours`, 2026-10-24)

The holds (#636) and the no-timed-wait nudge (#639) went live at 08:27Z (portal 8b31876). Exclusive time per hour of
the clock:

| Computer | Before: 72 h to 07:00Z | After: 08:00Z to 11:00Z (3 h) |
|---|---|---|
| BEAST | 18.1 h, 0.25 h per hour | 27 min, 0.15 h per hour: w1908 26 min, w1829 1 min; none at 10:00Z |
| LothDesktop | 9.6 h, 0.13 h per hour | 0 |
| LothLaptop | 1.4 h | 38 min: w1892 17 min, w2019 14 min, w1985 7 min |

The three timed asks after the deploy (journal, `timed ask`):

- w1789 (a Just Play UI A/B), 08:56Z: built on BEAST and sent by `timed_run` to LothLaptop as w2019, which timed it
  there for 14 minutes. This is the worker whose earlier report said it waited on m5.
- w1908 (factory info screens), 09:10Z: kept on BEAST, because its earlier A/B legs and its capture ran there and both
  sides of an A/B stay on one machine. Its ticket ended a batch build in BEAST's slot3 (w1860). This is the remaining
  BEAST exclusive time.
- w1440 (balance harness), 09:24Z: moved off LothDesktop and queued for LothLaptop as w2021. A big computer takes it
  only after 60 minutes.

Biscuit and m5 held no exclusive time. Nothing was timed on m5, and biscuit got no timed work in this window.

## 6. Risks

- **A borrowed player slot.** The daemon writes into a sandbox's `slotK-0`/`slotK-1` only while it holds the exclusive
  ticket and no live lease is on that pair (the bench gate refuses new players during a turn, w1750); it leases the pair
  for the turn and leaves a marker that matches no build, so `player_slots.py` refills it at the sandbox's next launch.
  Without `player_slots.py`'s OS mutex a launch racing the turn's start could still land; the gate makes that a narrow
  window.
- **The ticket's owner.** BenchTurn spares what a ticket's owner started; the daemon started every editor, so the run's
  ticket is owned by a small child process of its own, not the daemon (else no editor would be closed).
- **A single-worker computer.** LothLaptop has no turn limits as a single-worker computer. While a `timed_run` is queued
  or running there, it is not one (`singleWorker` false), so its own worker's turn ends at 30 minutes when the run waits.
