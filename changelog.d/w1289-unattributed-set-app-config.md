- **`set_app_config` sets whose Claude pool work nobody asked for runs on** (w1289, lothsahn: moving the nightly review and its
  regression jobs onto Ben's pool). New owner-only keys `vault.unattributed.intake`, `vault.unattributed.ffbox` and
  `vault.unattributed.nightly` take a user id that exists and has an enabled Claude token in the vault (`Vault.hasClaudeFor`);
  an unknown id or a person with no Claude pool is refused and nothing is written, and `null` goes back to the default
  (`lothsahn`). They apply to the running portal at once: the next intake, FFBox or nightly run reads them, no restart. Nothing
  else about the nightly changes. Docs: vault.md section 10. Tests: `unattributedConfig.test.ts`. **Needs lothsahn's portal deploy.**
