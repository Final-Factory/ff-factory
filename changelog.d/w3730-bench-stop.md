- **A person can stop a worker's bench ticket** (w3730; lothsahn: "Make sure that this situation can never happen again…
  get it fixed"). The machine's bench line on the dashboard has a Stop button for each worker's ticket (on the board, the
  exclusive holder's), which asks first; a person's own orchestrator has `stop_bench_ticket` for the same. Either sends
  the daemon's `bench_revoke` with the person's name: what runs under the ticket is asked to stop, its helper ends 90 s
  later if it still holds, and the holding worker is told who stopped it. Editors', timed runs', the urgent release
  lane's and the nightly's tickets are refused with the reason.
