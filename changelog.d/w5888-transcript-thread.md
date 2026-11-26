- **A resumed conversation's seal check and tool refresh run in their own thread** (w5888, for lothsahn: "look at
  speeding up portal deployment for updates so it goes faster"). Measured on the 2026-11-26 09:06 UTC deploy (ed34a73):
  the main thread ran 56-60 s of CPU a minute, and the dispatcher's 1.49 GB transcript took 427.8 s to check against
  its seal and 245.6 s to scan for stale tool records before its first turn, which came 712 s after it was asked. Both
  now run in `server/transcriptThread.ts`, which holds every running transcript hash (the main thread keeps a
  reference) and scans 64 MB at a time instead of reading the whole file into the portal's heap. A thread that fails
  or exits is logged (`transcript thread N: ... (w5888)`) and the work it held runs on the event loop as before; after
  three failed threads the process stops starting them, and `FFF_TRANSCRIPT_THREAD=off` keeps it all on the event loop.
