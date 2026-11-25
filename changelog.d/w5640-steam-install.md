- **A new urgent-lane computer sets steamcmd up by itself: `steam_upload` action `install`** (w5640, after w5551 closed
  `<root>/steam` to workers, so `urgent_release.py steam-install` refuses). The daemon downloads Valve's steamcmd into
  `<root>/steam/steamcmd`, runs it once to update, and writes `config.json`'s `release.steam` (account, steamcmd, home). A
  `check` or `upload` does the same first when anything is missing. The build account comes from the new portal setting
  `steamBuildAccount` (config.json), never from code; without it, and with no account in the computer's config.json, nothing
  is installed. docs/steam-upload.md. Needs a portal deploy, daemon updates, and `steamBuildAccount` set once.
