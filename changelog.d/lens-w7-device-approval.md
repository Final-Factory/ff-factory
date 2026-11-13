- **Device approval for members' logins** (Lens Scout factory's w7, docs/identity.md "Device approval"): with config
  `deviceApproval` `"members"`, a member's right password on a new browser waits until an owner approves that browser
  from a bar on their own page (and a push notice); the browser that redeems a set-password link is approved by it.
  Off by default, so nothing changes until an owner turns it on. `trustProxy` and `deviceApproval` are now owner-only
  set_app_config keys.
