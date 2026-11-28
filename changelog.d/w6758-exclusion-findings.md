- Machine exclusions (w6758, the w6756 review of w6754): decide_work queue never refuses a pair run's needs under
  `placement.exclusions` enforce; enforce's log lines say what they did (pins are only logged, needs are added to); a
  pair-run retry filed before w6754 keeps off the computer the server cited as a failed leg; the audit's marks are kept on
  the request, so a restart never logs one again.
