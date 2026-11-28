- Machine exclusions, stage 2 (w6754): config `placement.exclusions` (`warn` by default, `enforce`, `off`). Under
  `enforce` a pair avoid or a queue's needs with no live reason is dropped and the request re-queued, request_pair says
  which avoid it did not apply, and decide_work queue refuses such needs. The warn lines lose their false positives: a pin
  on the machine the work is about, a timed_place pin, needs that repeat the pin, re-logs after a restart or an offline
  flap; a failed leg of a retried pair run counts, build and play holds read as machine holds, and a crash hold counts
  only for its own request and its pair runs.
