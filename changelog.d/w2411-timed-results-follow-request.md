- **A timed run's result follows its request to its new worker** (w2411, lothsahn: "File a fix so timed-run results follow the
  request to its new worker"). Results went to the worker that filed the run; after a move that worker's message was dropped
  by the w2079 rule (w2257's tr_0d985b752b, w2363's tr_0ed821dfd1 and tr_84cc11005b). Now a result goes to the worker that
  holds the request when the run ends; with none it is kept on the run and handed to the next worker on the 5-minute tick
  (up to 3 days), and one dropped from an old worker's queue is sent again. The request's log says where each result went.
  A move drops no queued run; one whose build is gone from the portal fails and says so on its request. Docs: machines.md
  ("A result follows its request"). Tests: `w2411TimedFollowsRequest.test.ts`.
