- **A page that reconnects after a long gap gets only the sessions that changed** (w6456, lothsahn). Past 10 minutes a
  page asked for the whole list: 1.9-4.5 MB per reconnect on 2026-11-27, about 30 of ben's tabs at once at 16:09Z. It now
  sends its sessions' rev after any gap; a page copy that gains or loses its last report with no change to its session
  is a new rev too, kept across restarts, so the page still lands where a fresh load does.
