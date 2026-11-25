- Fenced workers can't read the machine's own Claude login: its `.credentials.json` files are closed with the secrets by
  the read fence on every OS (Windows No-Read-Up label, Seatbelt, Landlock), in the read fence's `on` mode. On Windows a
  login on the system drive is labelled only on BEAST; other machines keep C: untouched (w5559).
