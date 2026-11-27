- **A page that reconnects right after a portal restart keeps its sessions; page connects skip work they did before**
  (w6382, lothsahn). The saved session revs are taken as soon as the file is read, and each content key is checked when a
  reconnect first needs it (the 12:52Z restart's 15.6 s check had sent both early reconnects all 987 sessions, 2.4 MB).
  Each connect's session filter and page copies are kept while a session is unchanged, and the report excerpts are worked
  out at start rather than in the first connect's build (187 ms of a 728 ms build).
