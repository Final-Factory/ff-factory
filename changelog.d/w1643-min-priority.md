- **A computer can be reserved for higher work** (w1643, lothsahn: "let's make the setting the minimum priority work that
  can go to a machine. If normal (all work), if high, high and urgent, if urgent, urgent only"). `set_app_config
  placement.minPriority { "beast": "urgent" }` (normal, the default, takes all work, low included; null clears). Work below
  a computer's level never goes there and waits Queued rather than overflow, like a hold; a request raised to the level may
  go at once. start_agent, message_agent with a new request, stop_agent move_to and moves for a build follow it; the
  workers already there and their resumes go on; a release build counts as urgent. The Capacity block, list_machines, the
  Queued reasons and the dispatcher's prompt say which computer is reserved and at what level. Docs: machines.md ("Placing
  work"). Tests: `w1643MinPriority.test.ts`, `orchestrators.test.ts`, `appConfig.test.ts`.
