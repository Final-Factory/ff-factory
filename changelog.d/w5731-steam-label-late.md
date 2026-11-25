- **Windows closes `<root>/steam` to Low workers before steamcmd is installed** (w5731): the daemon makes the folder
  before it labels the root, at start and when the read fence is switched, so a machine's first `steam_upload` no longer
  leaves it readable until the next daemon start. steamcmd's `config.vdf` (its cached login), `config.json` and
  `uploads.json` each get their own No-Read-Up label, so one left with an explicit Low label is closed too. Follows the read
  fence's mode; `read-fence-off` takes the labels off. docs/worker-fence.md "Reads".
