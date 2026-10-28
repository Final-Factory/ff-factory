- **A worker its machine stopped mid-turn holds its request Blocked on that machine, not Stalled** (w2433, lothsahn). When a
  machine's link drops mid-turn, each request the worker holds is Blocked on that machine; when the machine is back, the
  worker resumes once, in its own sandbox, told why its turn stopped (the sandbox is no longer released in the minute after
  the reconnect). After `ledger.offlineNoticeMinutes` (default 60) offline, the dispatcher gets one `[ledger]` notice per
  machine naming the requests, their workers and whether their sandboxes hold unpushed work. A request's Latest line no
  longer shows a question a person has already answered (w2320's did, for an hour): it says who answered and when until the
  worker reports again. docs/orchestrators.md, "What a request is doing now" and "Waiting, Queued, Blocked".
