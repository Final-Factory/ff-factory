- **Max posts can carry images** (w2723, lothsahn: "Can't you send it to a worker and do this work and send it back to
  discord?"). `post_as_max` takes `images`: up to 4 PNG or JPEG files in the worker's working or temp folder, at most
  4 MB each and 8 MB together. The daemon reads them, the portal sends them to FFBox in parts (`post_file_put`), and
  `post_message` names them so FFBox posts them with the text through `ffdiscord post --file`. Every guard stays
  FFBox's: the channel allowlist, the bug channels only through a conversation, no mention, the secret scan, the
  refusal of a "fixed" post after a merge notice, the dedupe and the rate. Needs this portal, the machine's daemon, and
  FFBox's ffbox master with `post_file_put`. Docs: ffbox.md ("Posting as Max"), max.md. Tests: `ffboxPost.test.ts`,
  `ffboxPostFile.test.ts`.
