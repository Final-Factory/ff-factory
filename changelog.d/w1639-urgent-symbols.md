- **An urgent-lane release's symbols reach FFBox's store** (w1639; lothsahn: "Please make sure that if beast does a build that
  the symbols get uploaded to ffbox in the normal place so it can diagnose crashes and desyncs"). The worker tool
  `file_ffbox_symbols` sends the archives `urgent_release.py` packed (published with `publish_attachment`) to FFBox over its own
  connector link, as `symbols_put` parts the connector answers itself, then asks FFBox to file each build (`symbols_ingest`).
  FFBox opens no new endpoint. docs/ffbox.md, "Symbols of an urgent-lane build".
