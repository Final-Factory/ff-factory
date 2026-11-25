- **New-device approval for owner logins, advisory for now** (w5524, asked by lothsahn; finding 15 of the w5452 security
  audit; docs/identity.md "Owner device approval"): new setting `ownerDeviceApproval` (`off` | `advisory` | `enforce`,
  default `advisory`, owner-only, set_app_config, read live). In advisory an owner's login from a new browser outside the
  tailnet still goes through, but the owners see it in the bar and in Settings > Devices, and it is logged as one enforce
  would have held ("would need approval"). Settings > Devices lists every remembered browser with Approve, Deny and
  Revoke, and the logins held or that would have been held over the last 180 days. Logins over the tailnet are never held
  and approve their browser, so there is always a way in. Enforce is not on anywhere yet.
