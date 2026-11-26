- **A pre-w5297 pair run goes on Windows only where the agents were measured at Medium, and start_agent enforces it**
  (w6003, for lothsahn; w6002's leg ran on lothdesktop/slot5 at Low). Each Windows daemon now runs `whoami.exe /groups`
  the way its sandbox agents' commands run (the agent Git bash with the Low fence on, the daemon itself with it off) and
  sends the level with its worker fence (`WorkerFenceReport.agentIntegrity`). Placement of a pre-w5297 pair run on Windows
  reads that measured level and never the fence setting: Low, or no measurement (a daemon before this change), is refused.
  `start_agent` now checks each leg against the same rule (the dispatcher had started w6002 by name, and that path never
  asked placement), and `request_pair` files nothing when too few computers fit: it answers "no computer fits", naming each
  computer and why, and says plainly when no Windows sandbox agent measures Medium. The fence itself is unchanged.
