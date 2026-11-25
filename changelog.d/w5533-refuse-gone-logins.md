- **A key or a login whose user no longer exists is refused** (w5533, security finding 25 of w5452): an `/mcp` API key
  bound to a login that `users.json` no longer has, and a browser session of such a login, now get a 401 instead of
  acting as the owner. The session ends on the spot; an open page of that login is closed. The owner default is gone from
  `requesterOf`, the page state and the live-view list; only an unbound key (made before keys had users) still acts for
  the owner, by name in `server/mcp.ts`.
