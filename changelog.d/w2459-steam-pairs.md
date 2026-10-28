- **A pair run that needs Steam goes only on computers signed in to Steam, a different Steam account on each leg** (w2459,
  lothsahn). w2458, the pair run for the game's lobby-browser PR #2757, put its client leg on biscuit, which has no Steam
  client, and died at its Steam check; w2452 died with Steam signed out. Each daemon now reports its Steam client every 5
  minutes (`steam_client`: installed, running, the signed-in account's id and display name, offline mode; never its login
  name), read from Steam's own registry keys and files only (`machine/steamClient.ts`), and `list_machines` shows it.
  `request_pair` takes `steam` (why its legs need Steam), or reads the need from a lobby or a Steam join in its words;
  `steam: "none"` says it needs none. Placement keeps its legs on signed-in computers, one per account, and `start_agent`
  refuses a leg elsewhere. When the fleet has too few such computers, the run is Blocked on a new `steam` gate that names
  each computer and what it lacks, and clears by itself once enough are signed in. Needs a portal deploy and daemon updates;
  until a machine's daemon is updated it reads "not reported yet" and takes no Steam pair leg.
