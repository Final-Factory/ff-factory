- **The portal logs each page's live connection opening and closing, so "Connection lost" can be explained** (w4723;
  lothsahn: "Why do I keep getting connection lost?"). One line per open and per close: the person, their address and
  whether it came over Tailscale Funnel or the tailnet, the close code and reason, who closed it (the page, the server's
  ping timeout or the network) and how long it was open. The page now says in its connect URL why it reconnected (its
  socket closed, it heard nothing for 45 s, a tab came back, the network came back), logged beside the open line.
  `/api/health` counts the drops (`pageSockets`), per person when asked from the VM (`fffctl status`). docs/portal-logs.md.
