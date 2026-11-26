- **A cut update bundle download is resumed by the next update instead of starting again** (w5898, after w5643: beast
  fetched one 29.3 MB bundle four times from 0 on 2026-11-25, each 480 s attempt reaching 16.6-22.0 MB). The daemon keeps
  `<appDir>/update/<sha>.bundle.part` when a call runs out, and the next call for the same bundle hashes it again and asks
  the portal for the rest with a Range request. Each call keeps its 8 minute limit, and the whole file's SHA-256 is still
  checked before anything installs: a resumed bundle that does not match, a part that is not a file, empty or too long, or
  a 416 answer deletes the part and downloads from 0, with nobody at the machine. A refusal keeps nothing. Docs:
  worker-install.md ("Updates over the daemon's link"). Tests: `machineLink.test.ts` (w5898).
