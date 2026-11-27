- **A busy ffu slot target is trimmed in the first idle gap between builds** (w6290, after w5795). When a clean-up pass
  keeps a slot's cargo target over the 16 GB cap because a build or a test runs from it, the daemon judges that slot again
  by the same rule every 5 minutes until the next pass, and takes what an idle pass would take once the slot is idle
  (`machine/ffuBusyRetry.ts`, `staleOutput.ffuBusyRetry`, now `on` by default after a warn-only day on LothDesktop with zero
  bad plans). It removes nothing while a pass runs, also when one starts during its plan (w6304's review, point 4).
