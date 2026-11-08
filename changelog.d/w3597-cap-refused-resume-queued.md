- **A resume a machine refuses at its agent cap waits for a slot instead of failing** (w3597, lothsahn: "the resume must be
  queued and retried as soon as a slot frees"). On 2026-11-08 ffu #452's merge cleared the gates of w3564, w3567 and w3587 in
  one pass; the portal counted room on BEAST for each resume, because a process it had just started was not mid-turn on its
  side until the daemon reported it, so the daemon refused the ones past `max_sandbox_agents` and each request showed
  "Stalled (<worker> failed)" with nothing to retry it. Now a turn the portal sends counts toward the caps from the moment it
  is sent (for up to 2 minutes, until the daemon reports it), and a daemon's cap refusal (`max_sandbox_agents`,
  `max_agents_per_sandbox`, the machine's agent cap) puts the message back in the send queue, ahead of later messages to that
  worker. The request shows Queued (a free agent slot), the message is tried again when any turn ends or after a minute, and a
  resume may move to a computer with room (w2046). The caps are unchanged. Tests: `machines.test.ts` (w3597).
