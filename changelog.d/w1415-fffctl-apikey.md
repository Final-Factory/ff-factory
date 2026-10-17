- **`fffctl apikey`: the orchestration worker makes a member login's API key, straight into a file on a machine** (w1415,
  asked by Ben). `fffctl apikey issue NAME --user ID [--create-member [--display-name TEXT]] --machine TARGET --path FILE`
  makes the member login if asked (a random password nobody sees), mints a `/mcp` key bound to it through the portal's own
  code as the portal's account (`server/memberKeyCli.ts`), and writes it over the portal's ssh into a 0600 file on the
  machine, the way `credential issue` does: the key is in no output, log or transcript, only its last four characters.
  `fffctl apikey list` and `fffctl apikey revoke NAME` too. Refused: owner logins, `ben` and `lothsahn` in any case, a
  key name the owner's, a scoped or another login's key holds. `redactSecrets` now also hides `ffsb_` keys. Needs a portal
  deploy (the VM's fffctl and fff-ops-priv come with it). Docs: ops-worker.md. Tests: `memberKeys.test.ts`,
  `opsFffctlForms.test.ts`, `opsWorker.test.ts`, `fff-ops.test.sh`, `ci-vm-e2e.sh`.
