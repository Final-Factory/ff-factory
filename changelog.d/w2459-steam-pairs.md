- **A pair run that needs Steam goes only on computers signed in to Steam, a different Steam account on each leg** (w2459,
  lothsahn). w2458, the pair run for the game's lobby-browser PR #2757, put its client leg on biscuit, which has no Steam
  client, and died at its Steam check; w2452 died with Steam signed out. Each daemon now reports its Steam client every 2
  minutes (`steam_client`: installed, running, the signed-in account's id and display name, offline mode; never its login
  name), read from Steam's own registry keys and files only (`machine/steamClient.ts`), and `list_machines` shows it.
  `request_pair` takes `steam` (why its legs need Steam), or reads the need from a lobby or a Steam join in its words;
  `steam: "none"` says it needs none. Placement keeps its legs on signed-in computers, one per account, and `start_agent`
  refuses a leg elsewhere. When the fleet has too few such computers, the run is Blocked on a new `steam` gate that names
  each computer and what it lacks, and clears by itself once enough are signed in. Needs a portal deploy and daemon updates;
  until a machine's daemon is updated it reads "not reported yet" and takes no Steam pair leg.
- **A Steam client that runs but is not connected counts as signed out** (w2461: BEAST's Steam had been logged off since
  2026-10-25, "Logged In Elsewhere", then "Try another CM" on every sign-in): the daemon reads the tail of Steam's
  `logs/connection_log.txt` and names the log-off and the failed sign-ins.
- **A pair run whose legs click the game's menus goes only on computers whose screen is unlocked** (w2459, lothsahn:
  w2460's rerun 2 put its host leg on m5, signed in to Steam, behind a locked screen, where the menus take no clicks).
  Every Steam pair counts; others with `request_pair menus`, or words naming a menu, a lobby or a click (`menus: "none"`
  clears it). Daemons report whether the screen is locked (macOS session, Windows lock screen), `list_machines` shows
  it, placement skips a locked computer and `start_agent` refuses a leg there.
