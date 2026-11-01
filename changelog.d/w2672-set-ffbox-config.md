- **Orchestrators can change FFBox's live settings over the connector** (w2672, lothsahn: "Give yourself a way to update
  ffbox settings over the tunnel"). The new `set_ffbox_config` tool (dispatcher and Lothsahn's and Ben's own
  orchestrators, only when a person asked in their own words) asks FFBox's `set_config` query to change one key of its
  `config.json`, today the two subscription holds, and never its secrets.env. FFBox keeps `config.json.prev`, logs who,
  why, old and new, applies the value live with no restart (so a release build is never cut short) and answers the
  effective value read back and a change id; `revert` with that id puts the old value back. With no key it lists the
  settable keys, their values now and the recent changes. Docs: ffbox.md ("Changing an FFBox setting"),
  ffbox-connector-contract.md. Tests: `ffboxConfig.test.ts`.
