- **The portal page connects faster** (w5861, lothsahn: "When I close and reconnect to the portal website it takes 5-10
  seconds to connect. Why is it so slow?"). Opening the page loaded the whole state twice, once from `/api/state` and once
  as the socket's first message: 18 MB of JSON each on 2026-11-25, two to three MB each over Funnel once compressed, plus
  0.5-1.3 s of server time each. The page now takes the socket's copy only, and fetches `/api/state` only when an attempt
  fails or has not opened after 2.5 s. The page's sessions leave out the fields no page code reads, and the last report
  of a session no shown request names that has been idle 3 days (`server/pageState.ts`; a test fails when page code starts
  to read a left-out field). A page's socket gets 60 s before the ping timeout can end it, so a first state still
  downloading is not cut off and sent again. The log says where the state's bytes go, once an hour, and when the first
  state took a second or more to send. Docs: portal-logs.md. Tests: `pageState.test.ts`.
