- **New machines get a 10 / 15 / 20 GB disk guard and clean-up line** (w1951, lothsahn: "Let's set 10,15,20 as defaults in
  code for all new installs"). With nothing passed, a machine's guard stops idle editors below 10 GB free and refuses new
  sandboxes, editors and agents below 15 GB (was 20), and its clean-up works hard below 20 GB (was 80). The quarter-of-the-drive
  rule for the soft threshold keeps its 20 GB floor, so clean-up still starts before the guard refuses work; the Dev Drive
  sizing's 20 GB clean-up room is unchanged. The portal's own host guard keeps 20 / 10.
