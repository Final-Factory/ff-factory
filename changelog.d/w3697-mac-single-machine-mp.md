- **A pair run whose legs each run an MP scenario alone takes no Mac** (w3697, ben: after a wasted run, the harness
  learns). w3669, the pair run for PR #3433 (MP-W1587-gatling-tiers, "host and client, on one computer"), put leg 1 on m5,
  and all 3 runs ended 'env' in about 20 s at the game's `player_slots.py` `require_mac_client_ok` after a 10-minute Mac
  build. `shared/capacity.ts` `macRefusedScenario` now keeps a pair or request whose words name an `MP-*` scenario off every
  Mac (unfitWhy, so placement, Queued reasons and the pair plan agree; `start_agent` with pair_sandboxes refuses one too),
  unless it is cross-OS, its words name a pair lab (`lab.pair-*`) or `pair_relay` (leg 1 hosts, the others join), or they
  carry `FF_MAC_GPU_HANG_OK=<request>`, the guard's own override. The filed pair's brief and request_pair's answer say "no
  leg on a Mac"; request_pair's description no longer says a pair without cross_os takes no Mac at all.
