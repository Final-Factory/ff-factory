- **The portal page's state on connect carries only the sessions it shows** (w5907, the w5861 follow-up: 11.5 MB per
  connect after w5861, 8.9 MB of it 13,265 sessions). On open the page gets live sessions, every chat, those a shown
  request names, a sandbox's newest 12, those that still hold a sandbox or will come back, and those active in the last
  3 days; an older finished one is fetched when a view shows it (a session's page, a sandbox's "+N older" tabs) from
  `GET /api/sessions?ids=`. A page that reconnects within 10 minutes sends the `sessionsRev` it holds and gets only the
  sessions changed since, with the ids to keep (`server/pageState.ts` SessionRevs, `shared/pageSessions.ts`). The
  `/api/state` fallback (w5318) still sends the whole state. The open line now says how many sessions the state carried.
