- **The ledger cleanup no longer reads a finished report's words as an errored turn** (w1870, follow-up). The live check
  after w1870's deploy showed two misreads. w1867's worker had stopped after a finished report that said "`ff-pr merge`
  reported #562 as refused", and it would have been escalated as a refused tool. w1733's worker ended on "API Error: Can't
  reach the API server", and it would only have been asked whether it was done. Now a turn that ended with a report, and
  has no turn open since, is never trouble, and an "API Error" result is an errored turn that gets resumed. Tests:
  `ledgerErrors.test.ts`.
