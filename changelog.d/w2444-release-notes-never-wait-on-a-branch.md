- **A release's patch notes post once it is live on any Steam branch, and a Steam branch is never a card** (w2444,
  lothsahn on w2440: "It's a dev build but you still upload the patch notes. Why did you suddenly decide not to update
  patch notes for development builds. We've done that for ages"; on w2431: "Add the patch notes now. I'll update it later.
  Close the workitem"). `read_rules release` now says live means landed on the branch the lane sets (development
  included; a pre-1.0 hotfix once uploaded), that a brief says "once it is live on Steam", never "once live on default",
  and that the first signature check counts from the landing time. `waiting_on_person` refuses a card that asks a person
  to choose, set or move a Steam branch (`shared/releaseBranchAsk.ts`), with the go-live card for major content and the
  A-or-B card let through. Tests: `w2444ReleaseNotesNeverWaitOnBranch.test.ts`.
