- **`request_pair` takes `legs: 1`, a one-computer multiplayer check** (w4596, lothsahn: "speed up the pair and determinism
  syncs. A minor loss in coverage is acceptable"). An ffnightly.py run of an MP scenario on the default lab starts host and
  client on one computer, so each leg of a 2-leg pair was a full duplicate on another computer, and the second leg only added a
  wait for two computers with room at once (median 17 min, mean 33 min, hours on busy days). A run of 1 leg starts with
  `start_agent` `sandbox` alone, its worker is told it is the only leg, and a Mac stays off it when it starts an MP scenario's
  host and client (a Mac requester still gets one remote computer). `cross_os` still needs 2 legs or more. `decide_work`
  `pair_legs` takes 1 to 4, and the request tool, the dispatcher's pair rules and the worker notices name the one-computer case.
