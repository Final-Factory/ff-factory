- **A queued editor start now starts at its turn** (w1962, lothsahn: "a shared bench-queue ticket (an editor start, a
  build) must not wait for hours behind one exclusive timed ticket after another"). A start queued in the bench queue holds
  the Unity slot it took first (it is `starting`, which the machine's slot count counts), and at its turn the daemon checked
  the slots again and counted it twice: on LothDesktop, 2026-10-23, every turn slot1's and slot4's starts reached was refused
  with "needs 1, 0 free (3 of 3 in use) ... 3 granted not started yet" (7 times from 23:01Z, the portal journal), the ticket
  let go after 1 s and the start asked again at the back of the queue. Now the turn launches without a second check, and the
  pool's own count (no `editorSlot`) also counts a queued start. The slot line names those slots "editor starts queued or
  booting" apart from launches "granted not started yet". The daemon takes its bench tickets under the copy of
  `bench_queue.py` with the newest `RULES_VERSION` on the machine (`newestBenchQueueScript`), not a stale branch's copy.
  The queue's own rule changes (a shared ticket waits for one exclusive turn at most) are in the game repo's
  `scripts/bench/bench_queue.py`. Tests: `machineSandboxes.test.ts` (two w1962 tests), `unitySlots.test.ts`,
  `benchQueue.test.ts`.
