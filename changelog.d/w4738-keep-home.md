- **A worker released while it waited waits for its own computer first, and UI-heavy work skips one-Unity-slot computers**
  (w4738, r290 fix 4). On 2026-11-17 w4488's next step moved lothdesktop to m5 and then m5 to biscuit, each a fresh session
  that re-read its work. Now a worker whose sandbox was released while it waited on CI, a deploy, a person, a pair run or
  another request (`placeReleased.wait`) waits up to 15 min for a sandbox on its own computer before a room move (w2046);
  that day a sandbox freed there 1 to 12.1 min after each move. Strict priority (w3507, w4620) still holds. A room move of
  UI-heavy game work (a Live view, stills, play mode, the UI gate's tools: `needsUi`) leaves out computers with one Unity
  slot (biscuit) while another fits, and waits rather than going there. Docs: machines.md (under "A resume on a full
  computer moves to one with room"). Tests: `w4738KeepHome.test.ts`, placeAgain, workState.
