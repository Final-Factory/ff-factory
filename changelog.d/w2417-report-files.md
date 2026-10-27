- **A worker waiting on another request always gets the files that request's workers published** (w2417, asked by lothsahn:
  w2402's three zips and w2403's one were cut off the reports their waiting workers got, and each asked a person for the
  ids). An attachment record keeps the publishing worker's session, and a "Published files of wNNN's workers: name (size)
  att_…" block follows every relay of that request's report outside its cut: a gate's resume (whose wake note no longer
  stops at 2,000 characters), a pair run's result, `[worker update]`, `read_work {id}` and a line in the request's log. A
  worker may now `read_work` the requests its own wait or waited on (request gates, timed legs and pair runs filed for it)
  with no ledger-read grant (docs/attachments.md "Agents' files", docs/orchestrators.md "Workers read the ledger").
