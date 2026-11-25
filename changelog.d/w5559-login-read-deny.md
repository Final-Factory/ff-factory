- Fenced workers can't read the machine's own Claude login: its `.credentials.json` files are closed with the secrets by
  the read fence on every OS (Windows No-Read-Up label, Seatbelt, Landlock), in the read fence's `on` mode. On Windows a
  login on the system drive is labelled only on BEAST; other machines keep C: untouched (w5559).
- The start-up scrub's test checks its pieces on the portal's thread by their CPU time, not the wall time a loaded CI
  runner stretches (one piece 285 ms wall there); the log line gives both (w5559).
