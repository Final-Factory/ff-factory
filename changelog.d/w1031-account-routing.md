- **A request runs on the Claude pool and GitHub token of whoever last acted on it; intake on lothsahn's; Discord and FFBox by person** (w1031,
  lothsahn: "When a user on fffactory answers an intake question or otherwise updates a work item it should switch to them going forward. Use
  their Claude and GitHub tokens. Likewise intake should use my Claude and GitHub tokens. Discord inputs should follow ben if it's Ben's user
  requesting or mine if it's my user."). Answering a question, approving, declining, a note, a reopen, a priority change, Start now, filing again
  or joining it from Discord or FFBox (a person's own, in their own turn) sets `WorkItem.runsFor`; the switch is logged on the request, shown on
  its row and in `list_work`, and applies to the next worker process start. A worker's report, a harness message and the dispatcher's decisions
  never count. Requests the intake files for nobody (Discord bug threads, FFBox reports and diagnoses, release follow-ups, and now the nightly
  lab's regressions) run for lothsahn. A person with a Claude pool never falls back to the host token or another person's: a pool the vault cannot
  open holds the run with the reason. A missing GitHub token raises a host notice. `spend_report` attributes each turn to the account its process
  ran on. The nightly run and review jobs and the Sentry's delegations move to lothsahn too (`vault.unattributed.nightly` defaults to `lothsahn`; lothsahn: "Yes, move the nightly jobs to me"). **Needs lothsahn's portal deploy**, and `vault.unattributed.nightly` removed from config.json if it is set to `ben` (docs/vault.md section 10).
