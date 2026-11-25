- **Push subscriptions belong to the caller; notification clicks follow only `#` links** (w5534 and w5537, findings 26 and 29
  of the w5452 security audit). Changing, removing or re-subscribing a push endpoint now looks it up under the caller's own
  subscriptions: another person's endpoint answers 404 and changes nothing. The service worker opens a clicked
  notification's link only when it starts with `#` (on the dashboard's own origin), else the dashboard root; every URL the
  server pushes was already a `#` link. Tests: `notify.test.ts` (w5534), `swClick.test.ts`.
