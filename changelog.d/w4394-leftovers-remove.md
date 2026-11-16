- **`ff-leftovers remove <path>...`** (w4394): a clean-up worker can delete a folder `ff-leftovers check` judges DELETE. Before
  it there was no allowed route (only `remove-slot`, and the harness denies a raw `rm -rf`): on the m3, w4391's worker found
  `tmp/ffa-0fed07fc` (18 GB) and `tmp/ffa-5a411a7b` both DELETE and could remove neither. It judges each path as `check`
  does, again just before the delete, and refuses a KEEP path, anything outside the install folder or on C:, the main clone,
  `seed`, `secrets`, the daemon's folder, a top folder, a link or a path through one, and a player slot; it logs each removal
  with its size to `<install>/logs/ff-leftovers-removed.jsonl`. The worker guard reads it as a delete (outside the install
  folder or on C: is refused). The clean-up rules, `ff-leftovers folders`' footer and the low-disk brief rules name it.
