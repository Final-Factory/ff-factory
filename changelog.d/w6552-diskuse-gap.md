- **diskuse.ps1 splits V:'s "used" into folders, ReFS metadata and the rest** (w6552, after LothDesktop's V: showed 31 to
  45 GB used that no folder held). It ends with `Used = folders measured + ReFS metadata + not in them`, reading the
  metadata from `fsutil volume diskfree` (no elevation), and names the folders it did not measure: the excluded ones and
  any this account cannot list (the daemon's), where they printed as 0 GB before.
  - Fixed: `powershell -File diskuse.ps1 -Exclude steam,secrets` passed one string, so nothing was excluded. Lists are
    split on commas now, and `-Children` always skips `steam` and `secrets`.
  - Docs: sandbox-disk.md "Space no folder holds": on 2026-11-27 ReFS metadata was 14.8 to 20.5 GB of the gap and
    swung by 5.7 GB in a day; the ReFS log's event 142 keeps its history. The rest (13 to 22 GB) needs the elevated look
    the section lists. trim and compact do not reclaim it.
