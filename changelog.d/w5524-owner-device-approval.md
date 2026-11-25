- **New-device records for owner logins, advisory only** (w5524, asked by lothsahn; finding 15 of the w5452 security
  audit; docs/identity.md "Owner device approval"): new setting `ownerDeviceApproval` (`off` | `advisory`, default
  `advisory`, owner-only, set_app_config, read live). An owner's login from a new browser outside the tailnet always goes
  through; the owners see it in the bar and in Settings > Devices, and it is logged as "would need approval". Settings >
  Devices lists every remembered browser with Approve, Deny and Revoke, and those logins over the last 180 days. Logins
  over the tailnet approve their browser. Nothing refuses or holds an owner's login, not even an error in the check;
  holding them ("enforce") comes in a later change.
