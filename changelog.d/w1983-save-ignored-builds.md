- **Saving a finished worker's sandbox no longer fails on the game repo's ignored `Builds/`** (w1983): the build-folder
  exclusion added for `.nightly-builds/` named `builds/` to git as an exclude pathspec, and git answers a pathspec that names
  an ignored folder with "The following paths are ignored ... Use -f" and exit 1, so every save of lothdesktop/slot6 from
  06:56Z on 2026-10-24 failed and the sandbox stayed held. A save now excludes only the build folders the sandbox has that git
  does not already ignore. Needs the machines' daemon update.
