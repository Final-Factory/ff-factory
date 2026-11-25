- **ffu slots build with incremental off, and their old incremental caches go** (w5499, Ben: "Share one Rust build cache
  across FFU sandboxes per machine"). A slot's `.cargo/config.toml` now says `incremental = false` and `ffu-slot take`
  exports `CARGO_INCREMENTAL=0`, as ffu CI builds; the clean-up drops a slot's `debug/incremental` once no build wrote it
  for 15 min, held slot or not. Measured on BEAST: a fresh workspace test target is 9.1 GB instead of 14.2 GB and stays there
  after edits (16.5 GB with incremental), while slots in use had grown to 24 and 55 GB, 8.7 and 38.1 GB of it incremental; an
  edit rebuild is about 60 to 80 s slower. Release builds and the hashcheck are unchanged (1, 4 and 16 threads match the
  golden). `CARGO_INCREMENTAL=1` turns it back on for one shell. `ff-leftovers check`/`remove` now judge a slot checkout's
  `ffu/target` that ffu's scripts made (cargo's tag only in `target/compat-base` and the like) as build output, and
  `remove` of an FFU runner's job folder that a fenced worker cannot delete (the runners' Medium integrity label) says the
  daemon's rule `ffu-runner-work` takes it, instead of "the delete failed part-way". Applies with each machine's daemon
  update; a slot's config is rewritten at its next `ffu-slot take`. Docs: ffu-sandboxes.md.
