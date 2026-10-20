- **Close Firefox from a Windows PC's tray to free RAM, off unless turned on** (w1593, lothsahn: "Can you make the daemon have
  an option in the tray to nicely shutdown Firefox (not force kill) to free ram?"; "Closing Firefox should be off by default").
  The tray's "Allow closing Firefox from this menu" (kept in `<app_dir>/firefox.json`, off when missing) shows "Close Firefox to
  free RAM (it holds N GB)" while Firefox runs in that session. It closes Firefox's windows one at a time with WM_CLOSE, as
  their X does, never a kill; a prompt (close tabs?, a page asking to leave, downloads) or a Firefox still running after 45 s
  is left as it is and the notification says so. Each profile it had open restores its windows and tabs once at the next
  start (`browser.sessionstore.resume_session_once`), and the notification gives the free RAM before and after. Windows only:
  the daemon has no menu-bar app on a Mac. Docs: machines.md ("Closing Firefox to free RAM"). Tests: `firefox.test.ts`, with
  real windows on Windows. Checked on beast against a Firefox with a throwaway profile.
