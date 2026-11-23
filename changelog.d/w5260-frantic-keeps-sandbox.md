- **Urgent and frantic work keeps its sandbox between turns, and its resume never sits Queued** (w5260, lothsahn). On
  2026-11-23 w5186 (frantic, Build 63 waited on it) was released while blocked on CI, normal work took both free beast
  sandboxes, and its resume sat Queued 11 minutes after CI cleared until a person moved it, onto the wrong branch. Now a
  worker whose highest open request is urgent or frantic is never released for a wait between turns (only strictly higher
  work's reclaim takes its sandbox); a released one's resume with no room frees a sandbox from idle lower work on its
  computer, else moves at once (no w4738 home wait), else pre-empts a mid-turn low or normal worker at a safe point; and
  `stop_agent move_to` hands a released worker over on its own branch (or its open PR's head), never its old sandbox's.
