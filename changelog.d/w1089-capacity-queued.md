- **Waiting for room is Queued, never Blocked on a guessed time; "has room" is one test; the sidebar and the page count the
  same states** (w1089, lothsahn: "I see a number of items that are blocked waiting on sandboxes, but they're all in use.
  These should be in a queued state, not blocked."). The dispatcher had put five requests into "blocked on 04:35/04:40/…
  UTC (a free sandbox: all in use except the m5's (Ben testing))". Now `decide_work block` and a worker's `blocked_on` refuse
  a wait for a free sandbox, slot, editor, RAM or computer (`capacityWaitIn`, `shared/capacity.ts`) and say to queue; a block
  already recorded becomes Queued by itself, keeping its place and notes (`requeueCapacityBlocks`, run by the blocker watch).
  The Capacity block's ROOM/BUSY, `decide_work queue`'s refusal, the WRONG flag and the page all read one `roomNow`
  (`server/placement.ts`); a flag's log line now carries the computer's numbers at that moment (the "lothdesktop has room"
  lines were hours old). New `placement.hold` (`set_app_config`): a computer that takes no new work at all, with who and why
  (the m5 held for Ben's testing); a Queued request says "m5 has room but is held (…)". The sidebar row counted stored
  status ("34 active 6 queued") while the page counted live states; both use `ledgerGlance` over `workLiveAll` now. Docs:
  orchestrators.md "Waiting, Queued, Blocked" (when room is re-checked, what sends the capacity-freed ping). Needs a portal deploy.
- **Work that needs no Unity editor is placed by agent slot alone** (w1098, lothsahn: "FFBox and FF Factory updates don't need
  unity editors"). A request on FF Factory, FFBox, the plugin or any non-game repo needs no editor, no free game sandbox and
  no RAM for Unity: only an agent slot (the computer's agent cap, a seat in a sandbox), still respecting holds, avoids and the
  person's Claude pool. `request_work` takes `repo` and `needs`; `WorkItem.needs` is decided once at filing (given, from the
  repo, or a logged guess). `list_sandboxes` and `system_status` end with "Next non-game work: <computer>" beside the game line
  and show each computer's agent slot; a non-game request queued while one has a slot is WRONG like game work. The
  dispatcher's prompt carries the rule (docs/machines.md "Placing work"). Needs a portal deploy.
