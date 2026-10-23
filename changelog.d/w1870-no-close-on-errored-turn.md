- **The ledger never closes a request on a worker's errored turn, nor without its DONE** (w1870, lothsahn: "Please fix
  the closing job so it doesn't close out jobs with errors. Those should be resumed to fix the error or escalated to an
  operator if the error can't be fixed"). The cleanup had closed w1829 on its merged and deployed PRs while its worker's
  last turn had ended in `error_during_execution` mid-demo. Now the merged-PR close, its deploy close, a refused DONE
  re-checked after its PRs merge, a report that reads as delivered and the dispatcher's `decide_work done` all hold a request
  whose latest worker's last turn ended in an error or an interrupt, or whose last report is not a `DONE:` line for it.
  An error is resumed with the error lines and the brief's done criteria (a fresh worker through the dispatcher when the
  session cannot resume), and escalated to the request's person and an operator as a Waiting item ("Error escalated by the
  ledger cleanup", `[needs you]`) on the same error after a resume, a refused tool, or a login, permission or machine only a
  person can give. An interrupt by the dispatcher or a person is no error: the dispatcher places the work again. A report
  without a DONE leaves the request open and its worker is asked; a deploy that happened resumes it to finish. Docs:
  orchestrators.md ("Pull requests", "Ledger cleanup": "Never on an errored turn"). Tests: `ledgerErrors.test.ts`, the w1870
  tests in `ledgerSweep.test.ts` with the w1829 fixture (`ledgerSweep.fixtures.ts`).
