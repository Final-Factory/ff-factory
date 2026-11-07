- **A timed run's bench ticket is never parked because its worker is stopped** (w3398): the daemon waits on the ticket and
  plays the legs, so `benchPriorities` drops the worker's `away` mark on the machine where its run is live. tr_7673462869
  sat parked for about 3 hours on LothDesktop while its worker slept on the check-in timed_run asked for. The worker's
  message now says how many exclusive turns (at most 24 minutes each, under the queue's 30) its legs take (docs/machines.md).
