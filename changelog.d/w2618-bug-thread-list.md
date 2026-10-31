- **Workers list the Discord bug threads of a window themselves** (w2618): `list_ffbox_files what: "threads"` with `since`
  (and `until`, `channel`) answers every thread created in #bug-reports and dev_bug_reports in that window, with its URL,
  channel, title, created time, FFBox conversation id, state, verdict and PR, then the older threads written in during it;
  orchestrators get the same as `ffbox_activity show: "threads"`, and the conversations view names each one's thread id.
  Read-only, from FFBox's existing `bug_threads` query; titles are headed as untrusted players' data. Needs a portal and
  daemon deploy; nothing new on FFBox. [docs/ffbox.md](../docs/ffbox.md)
