- **The daemon link (/machine) now refuses connections from outside the tailnet** (w5575, PR 2 of 2; lothsahn: "File
  it: the daemon link accepts only tailnet connections"). `machineLinkTailnet` unset now means `enforce` (403 before the
  token is read); `warn` and `off` still work, and an unknown value counts as `warn`, so a typo never locks a daemon out.
  The warn-only deploy logged every online daemon on a tailnet address and no would-be refusal. Recovery:
  `set_app_config machineLinkTailnet "off"` (docs/machines.md, "The daemon link is tailnet-only").
