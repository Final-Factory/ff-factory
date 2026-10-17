- **The sidebar lists the chats that matter now, and calls you to a slot that waits on you** (w1430, Ben: "there are so many
  inactive chats in every slot in fff ... i also feel like if there is work waiting for live view workflow, it should be
  obvious maybe as a go button next to the slot"). Under each sandbox: the chats mid-turn, between turns with work going,
  coming back to their sandbox, on an open request (its current worker, whatever its process does), or waiting on a
  person, that one first. Finished chats and those on closed requests fold behind "+N older" (was "+N stopped"), which
  opens them in place; nothing is deleted. A slot whose worker waits on you gets an amber "Live view: go" (it streams a
  Live view) or "Needs you" (its chat) beside its row, one click away; the request's card on the Dispatcher's Waiting tab
  gets "Live view: go" too. `node scripts/sidebar-chats.ts data --as Ben` counts each slot's chats before and after.
  Web only: applies after a portal deploy. Docs: machines.md ("In the web UI"), live-view.md. Tests: `fleet.test.ts`,
  `e2e/fleet.spec.ts`.
