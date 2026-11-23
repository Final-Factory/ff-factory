- **Unity slots go by request priority first, and a higher priority takes an idle lower editor's slot, cleanly** (w5324;
  lothsahn: "If w5291 is frantic priority, how is it waiting for a slot?", then "High priority work should also preempt
  lower priority work as well, cleanly, of course"). The slot queue ranks frantic > urgent > high > normal > low before
  holders (w4620 put holders first, so a normal sandbox with its editor up went ahead of a frantic newcomer: w5291 waited
  about 2 h on LothDesktop). When the head does not fit, the daemon closes a strictly lower-priority sandbox editor that
  holds its slot alone, through the editor (save, then quit), skipped while its worker compiles or runs tests or it
  plays, imports or builds a player; it starts again once that run is done. The waiting reason names who holds the slots
  ("held by sandbox:slot2 (w5293, normal)"). A Unity process with no readable `-projectPath` is matched to its sandbox by
  `Library/EditorInstance.json` instead of counted "outside the slot gate", an over-limit notice waits 15 s and names
  each outside process's parent, and `unity start` reads the mailbox after the process list so a run granted meanwhile
  is counted. Needs a daemon update on each machine (docs/unity-lifecycle.md, "Unity slots").
