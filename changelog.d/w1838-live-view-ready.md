- **The Live view says "go" only when it can be used** (w1838, Ben: "don't show the live view go sticker thing on the slot.
  Only show that when it's ready and can be used"). The slot's badge, the panel and the knobs read one readiness
  (`shared/liveReady.ts`): "Live view: go" while frames flow, otherwise what it waits on (starting, editor stopped, editor
  starting, queued, paused for a build, editor closed, not in play mode, no frames, holding), each with why and what brings
  it back. The knobs wait calmly instead of showing red errors, and no panel says "knobs still work" when they don't.
  Opening a view whose editor stopped or whose game left play mode now wakes its worker to stage it again (before, only an
  idle-closed editor did), unless a build or bench lock holds the computer; the end of a build tells a kept view's worker to
  stage it. A view whose frames stop with the socket open goes to "no frames" after 10 s. The daemon looks for the game
  every second (play mode to first frame p50 1.6 s to 0.65 s) and the knobs of every material are read at once. Each
  state change is in the journal with its duration. Docs: live-view.md ("Ready or not"). Tests: `w1838LiveReady.test.ts`,
  `fleet.test.ts`, e2e `fleet.spec.ts`.
