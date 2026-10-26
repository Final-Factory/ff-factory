- **`fffctl disk-usage`: where the portal VM's disk went, for the orchestration worker** (w2267). Lothsahn asked what
  fills fff-portal (75 GB of 115 GB, about 43 GB of it unexplained under /srv/fff); the worker can neither read /srv/fff nor
  run `sudo du`. `fffctl disk-usage` prints sizes, counts, dates and paths only: `du -xh --max-depth=3 /srv/fff` (the 30
  biggest), each child of /srv/fff and of data/ with its files' oldest and newest dates, each release with its
  node_modules, the portal account's .claude, files of 200 MB or more, /var/log and the journal, and auth.log's and
  syslog's lines counted per day by the program that wrote them (never a line's text or a command's arguments). Read
  only; `fff-ops-priv` passes it with no option. Needs a portal deploy. Docs: ops-worker.md. Tests:
  `fff-disk-usage.test.sh`, `fff-ops.test.sh`, `configAccess.test.ts`.
