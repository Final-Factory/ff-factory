- **Queued work is WRONG only beside room it can use, and the capacity ping is prompt** (w1944, lothsahn: "Dispatcher leaves
  21 requests queued while biscuit and m5 have room"). A computer a request cannot run on is no room for it: timed work on
  a computer that takes no timed runs or on another platform than it names, and an MP scenario (`MP-<name>`) on a Mac, which
  refuses its multiplayer client. list_work, the page, the WRONG STATE flag, the capacity ping and `decide_work queue` all
  use that test, and the Queued line says why ("m5 has room but cannot take it: m5 is a Mac, …"). Room counts toward WRONG
  once it has stood 5 minutes (before: "m5 has room since 1 min ago: the capacity ping brings it"). The ping is never held
  more than 2 minutes by a stream of events, urgent work that fits skips its hourly cap, a daemon's hello wakes it (after a
  portal restart), and the journal logs each ping sent. Docs: orchestrators.md ("Queued"). Tests: `w1944QueuedRoom.test.ts`,
  `orchestrators.test.ts`.
