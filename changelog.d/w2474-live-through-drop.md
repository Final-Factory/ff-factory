- **A worker that ran on through its machine's drop is no longer shown Blocked, or told its turn stopped** (w2474, ben).
  On 2026-10-28 every machine dropped off the portal several times (the portal's redeploy, each daemon's update, biscuit's
  missed heartbeats, the portal VM's Tailscale upgrade at 11:07Z); the workers' processes ran on, but each drop marked
  their requests "stopped mid-turn" and Blocked, and could wake them with a false "your turn stopped" note. Now the
  daemon's hello lifts that wait for every worker it reports running, and the blocker watch counts a machine back only
  after its hello (docs/orchestrators.md).
