- **A disk block is not recorded while the disk is already above its line, and the daemon's guard lets agents start at that
  same line** (w5167). On 2026-11-23 at about 03:48Z lothdesktop's V: was back at 24 GB free over its 15 GB warning line; the
  disk gates cleared at 15 + 5 GB, but the daemon's host guard still refused the resumed workers ("disk space is low
  (V:\ffw\sandboxes 24 GB free); new agent processes wait") because it lifted its low level only at 15 + 10 GB (the Dev Drive
  install's `hysteresisGB` 10). The dispatcher then blocked w5154, w5155, w5162 and w5163 on disk again, and each block cleared
  the same minute. Now the sandbox volume's guard lifts at the warning line + 5 GB, the gate's own margin; `decide_work` block
  kind `disk` and a report's "paused for low disk" are refused or skipped while the disk is at or above that line (as
  `blocked_on` disk already was, w4257). Needs a portal deploy and the machines' daemon updates.
