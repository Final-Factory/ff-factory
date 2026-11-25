- **The dashboard page's websocket refuses messages over 1 MiB** (w5527, finding 19 of the w5452 audit; lothsahn: "cap websocket
  messages at 1 MiB"): the page server had no `maxPayload`, so ws's 100 MiB default let one message spike the portal's memory.
  The page sends nothing over `/ws` (chat, pastes, dictation and attachments go over HTTP), so no real message comes near the cap;
  a larger one closes the socket with 1009 and the page reconnects with its usual backoff. The machine, provider and live sockets
  keep their own limits. Needs a portal deploy.
