- **A runner that holds a bench ticket and waits for a second one says both** (w1968, seen live on LothDesktop at 02:39Z:
  w1782's worker held a shared ticket for one player and waited for a second). It reads "Blocked: waiting for the shared
  bench lock on lothdesktop (…) · holds a shared bench ticket on lothdesktop (t00000942 for w1782, since 02:24 UTC)", so
  the holder never hides behind its own wait. Tests: `w1968AgentQueue.test.ts`.
