- **A page's state build works out each sandbox's FREE once** (w6428, for lothsahn: after #1464 the 'room' and 'machines'
  phases of a page connect's build were 84-270 ms of 154-560 ms). The build runs in `Agents.pageRead`, which keeps free() of
  each sandbox for the build: the machine views asked every sandbox, then placesNow asked it again for freeSandboxes and
  idleEditors. The answers, the room and the page's data are the same; a sandbox object its daemon sent again is asked
  afresh. Only the page build uses it (it changes no placement; the drains and release passes keep withPlacesOnce).
  Tests: `loopBlocks.test.ts`; `scripts/bench-loop-blocks.ts` counts free() per build.
