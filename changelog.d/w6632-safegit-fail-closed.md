- **safeGit's fence closes three more ways past its config scan** (w6632, w6633, w6650; found by 9db5328a's reviews
  w6629, w6638, w6649 and w6652). A scan that does not end by itself (output over 4 MiB, its 15 s timeout, a signal, an
  unexpected exit) now refuses the call instead of trusting the rows read before the cut (w6632). `fetch -m`, `-qm` and any
  long-option prefix down to `--m` count as fetching several remotes (w6633). `remote add` with its fetch (`-f`, `--fetch`,
  `-ftmaster`, ...) is refused in every checkout, since an `includeIf "hasconfig:remote.*.url:..."` plant switches on only
  after the URL is written; add the remote, then fetch it (w6650). `remote`'s verb is read past its own `-v`/`--verbose`.
  Tests: `server/safeGit.test.ts`.
