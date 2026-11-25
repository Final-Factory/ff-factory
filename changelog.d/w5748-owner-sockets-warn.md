- **The Linux read-fence probe now says whether a fenced run reaches the owner's secrets over a socket** (w5748, from
  w5733's review of #1232). In `warn` and `on` modes it connects (sending nothing) to the session bus, where the Secret
  Service keeps a desktop Linux gh login, to GNOME keyring's sockets and to the ssh and gpg agents, from a child under the
  run's own lock, and logs one line: how many were refused, which answered, and the kernel's Landlock ABI. Warn only: no
  run changes. On biscuit (Linux 7.0, ABI 8) all 12 answer, since refusing a socket's connect needs ABI 9 (Linux 7.1).
  The options, their measured costs and the pick: docs/worker-fence.md, "The Secret Service and the agents".
